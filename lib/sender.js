'use strict';

const config = require('config');
const log = require('npmlog');
const os = require('os');
const fetch = require('nodemailer-fetch');
const iptools = require('./iptools');
const bounces = require('./bounces');
const Headers = require('mailsplit').Headers;
const SMTPConnection = require('smtp-connection');
const net = require('net');
const PassThrough = require('stream').PassThrough;
const dkimSign = require('./dkim-sign');
const EventEmitter = require('events');
const plugins = require('./plugins');

class Sender extends EventEmitter {

    constructor(clientId, connectionId, zone, sendCommand) {
        super();

        this.clientId = clientId;
        this.connectionId = connectionId;

        this.zone = zone;

        this.tlsDisabled = new Set();

        this.sendCommand = (cmd, callback) => {
            if (typeof cmd === 'string') {
                cmd = {
                    cmd
                };
            }
            sendCommand(cmd, (err, data) => callback(err, data));
        };
        this.closing = false;
        this.ref = {}; // object value for WeakMap references
        this.emptyChecks = 0;
        this.sendNext();
    }

    close() {
        this.closing = true;
    }

    sendNext() {
        if (this.closing) {
            return;
        }

        this.sendCommand('GET', (err, delivery) => {
            if (err) {
                this.closing = true;
                this.emit('error', err);
                log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                return;
            }

            if (!delivery || !delivery.id) {
                this.emptyChecks++;
                return setTimeout(() => this.sendNext(), Math.min(Math.pow(this.emptyChecks, 2), 1000) * 10);
            }
            this.emptyChecks = 0;

            delivery.headers = new Headers(delivery.headers);

            this.zone.speedometer(this.ref, () => { // check throttling speed
                let handleError = (delivery, connection, err) => {
                    this.handleResponseError(delivery, connection, err, () => false);
                    return setImmediate(() => this.sendNext());
                };

                // Try to connect to the recipient MX
                this.getConnection(delivery, (err, connection) => {
                    let recivedHeader;
                    if (err) {
                        // ensure that we have a received header set
                        let recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, os.hostname()));
                        delivery.headers.addFormatted('Received', recivedHeader, 0);
                        return handleError(delivery, connection, err);
                    }

                    recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, connection.options.name));
                    delivery.headers.addFormatted('Received', recivedHeader, 0);

                    if (config.dkim.enabled) {
                        // tro to sign the message, this would prepend a DKIM-Signature header to the message
                        this.signMessage(delivery);
                    }

                    delivery.envelope = {
                        from: delivery.from,
                        to: delivery.recipient
                    };

                    plugins.handler.runHooks('sender:headers', [delivery], err => {
                        if (err) {
                            connection.close();
                            return handleError(delivery, connection, err);
                        }

                        let messageHeaders = delivery.headers.build();
                        let messageSize = recivedHeader.length + messageHeaders.length + delivery.bodySize; // required for SIZE argument
                        let messageFetch = fetch('http://' + config.api.hostname + ':' + config.api.port + '/fetch/' + delivery.id + '?body=yes');
                        let messageStream = new PassThrough();

                        messageStream.write(messageHeaders);
                        messageFetch.pipe(messageStream);
                        messageFetch.once('error', err => messageStream.emit('error', err));

                        // Do the actual delivery
                        connection.send({
                            from: delivery.envelope.from,
                            to: [].concat(delivery.envelope.to || []),
                            size: messageSize
                        }, messageStream, (err, info) => {
                            // kill this connection, we don't need it anymore
                            connection.close();

                            if (err) {
                                messageStream = null;
                                messageFetch = null;
                                return handleError(delivery, connection, err);
                            }

                            log.info('Sender/' + this.zone.name + '/' + process.pid, 'ACCEPTED %s.%s for <%s> by %s (%s)', delivery.id, delivery.seq, delivery.recipient, delivery.domain, this.formatSMTPResponse(info.response));

                            this.releaseDelivery(delivery, err => {
                                if (err) {
                                    log.error('Sender/' + this.zone.name + '/' + process.pid, 'Can\'t get message acknowledged');
                                    log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);

                                    this.closing = true;
                                    return this.emit('error', err);
                                }
                            });
                            return setImmediate(() => this.sendNext());
                        });
                    });
                });
            });
        });
    }


    handleResponseError(delivery, connection, err, callback) {
        let bounce;
        let deferredCount = delivery._deferred && delivery._deferred.count || 0;
        let smtpResponse = this.formatSMTPResponse(err.response || err.message);

        if ((bounce = bounces.check(err.response)).action !== 'reject' || deferredCount > 6) {
            let ttl = Math.min(Math.pow(5, deferredCount + 1), 1024) * 60 * 1000;
            log.info('Sender/' + this.zone.name + '/' + process.pid, 'DEFERRED[%s] %s.%s for <%s> by %s: %s (%s)', bounce.category, delivery.id, delivery.seq, delivery.recipient, delivery.domain, bounce.message, smtpResponse);
            return this.deferDelivery(delivery, ttl, err => {
                if (err) {
                    log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);

                    this.closing = true;
                    return this.emit('error', err);
                }
                return callback();
            });
        } else {
            log.info('Sender/' + this.zone.name + '/' + process.pid, 'REJECTED[%s] %s.%s for <%s> by %s: %s (%s)', bounce.category, delivery.id, delivery.seq, delivery.recipient, delivery.domain, bounce.message, smtpResponse);
            return this.releaseDelivery(delivery, err => {
                if (err) {
                    log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                    this.closing = true;
                    return this.emit('error', err);
                }

                setImmediate(() => this.sendBounceMessage(delivery, bounce, smtpResponse));

                return callback();
            });
        }
    }

    getConnection(delivery, callback) {
        let domain = delivery.domain;

        let resolveMx = (domain, next) => {
            if (this.zone.host) {
                return next(null, [{
                    exchange: this.zone.host,
                    priority: 0
                }]);
            }

            let exchanges = [];
            plugins.handler.runHooks('sender:mx', [delivery, exchanges], err => {
                if (err) {
                    return next(err);
                }

                if (exchanges && exchanges.length) {
                    return next(null, exchanges);
                }

                iptools.resolveMx(domain, next);
            });
        };

        resolveMx(domain, (err, exchanges) => {
            if (err) {
                return callback(err);
            }

            if (!exchanges) {
                // try again later (4xx code defers, 5xx rejects) just in case the recipients DNS is down
                err = err || new Error('Can\'t find an MX server for ' + domain);
                err.response = '450 Can\'t find an MX server for ' + domain;
                return callback(err);
            }

            let mxTry = 0;

            let tryConnectMX = () => {
                let err;
                if (mxTry >= exchanges.length) {
                    err = new Error('Can\'t connect to MX');
                    err.response = '450 Can\'t connect to any MX server for ' + domain;
                    return callback(err);
                }
                let exchange = exchanges[mxTry++];
                iptools.resolveIp(exchange.exchange, this.zone, (err, ipList) => {
                    if (err) {
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, 'Error resolving A/AAAA for %s. %s', exchange.exchange, err.message);
                        return tryConnectMX();
                    }
                    if (!ipList.length) {
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, 'Could not resolve A/AAAA for %s', exchange.exchange);
                        return tryConnectMX();
                    }

                    let ipTry = -1;
                    let tryConnectIP = retryConnection => {
                        if (!retryConnection && ipTry >= ipList.length - 1) {
                            return tryConnectMX();
                        }
                        let ip = retryConnection ? ipList[ipTry] : ipList[++ipTry];
                        let zoneAddress = this.zone.getAddress(delivery.id + '.' + delivery.seq, net.isIPv6(ip));
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, 'Resolved MX for %s as %s[%s]. Using %s (%s[%s]) to connect', domain, exchange.exchange, ip, this.zone.name, zoneAddress.name, zoneAddress.address);

                        let options = {
                            servername: exchange.exchange,
                            host: ip,

                            port: this.zone.port,
                            localAddress: zoneAddress.address,
                            name: zoneAddress.name,

                            requireTLS: !this.tlsDisabled.has(ip),
                            ignoreTLS: this.tlsDisabled.has(ip),

                            opportunisticTLS: true,
                            secure: !!this.zone.secure,
                            authMethod: this.zone.authMethod,

                            tls: {
                                servername: exchange.exchange,
                                rejectUnauthorized: false
                            },

                            logger: ('logger' in this.zone ? this.zone.logger : config.log.mx) ? {
                                info: log.verbose.bind(log, 'Sender/' + this.zone.name + '/' + process.pid + '/SMTP'),
                                debug: log.silly.bind(log, 'Sender/' + this.zone.name + '/' + process.pid + '/SMTP'),
                                error: log.error.bind(log, 'Sender/' + this.zone.name + '/' + process.pid + '/SMTP')
                            } : false,
                            debug: ('logger' in this.zone ? this.zone.logger : config.log.mx)
                        };

                        plugins.handler.runHooks('sender:connect', [delivery, options], err => {
                            if (err) {
                                return tryConnectIP();
                            }

                            let connection = new SMTPConnection(options);
                            let returned = false;
                            let connected = false;

                            connection.once('error', err => {
                                connection.connected = false;
                                if (returned) {
                                    return;
                                }
                                returned = true;
                                if (err.code === 'ETLS') {
                                    // STARTTLS failed, try again, this time without encryption
                                    log.info('Sender/' + this.zone.name + '/' + process.pid, 'Failed to connect to %s[%s] using STARTTLS, proceeding with plaintext', exchange.exchange, ip);
                                    this.tlsDisabled.add(ip);
                                    return tryConnectIP(true);
                                }
                                if (!connected) {
                                    // try next host
                                    if (mxTry >= exchanges.length) {
                                        log.info('Sender/' + this.zone.name + '/' + process.pid, 'Failed to connect to %s[%s] for %s from %s (%s[%s])', exchange.exchange, ip, domain, this.zone.name, zoneAddress.name, zoneAddress.address);
                                    }
                                    return tryConnectIP();
                                }

                                log.error('Sender/' + this.zone.name + '/' + process.pid, 'Unexpected MX error');
                                log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                            });

                            connection.once('end', () => {
                                connection.connected = false;
                            });

                            connection.connect(() => {
                                if (returned) {
                                    return;
                                }

                                let auth = next => {
                                    if (this.zone.auth) {
                                        return connection.login(this.zone.auth, next);
                                    }
                                    next();
                                };

                                auth(err => {
                                    if (returned) {
                                        return;
                                    }
                                    if (err) {
                                        connection.close();
                                        return callback(err);
                                    }
                                    connected = true;
                                    connection.connected = true;
                                    return callback(null, connection);
                                });
                            });
                        });
                    };

                    tryConnectIP();
                });
            };

            tryConnectMX();
        });
    }

    formatSMTPResponse(str) {
        let code = str.match(/^\d{3}[\s\-]+([\d\.]+\s*)?/);
        return ((code ? code[0] : '') + (code ? str.substr(code[0].length) : str).replace(/^\d{3}[\s\-]+([\d\.]+\s*)?/mg, ' ')).replace(/\s+/g, ' ').trim();
    }

    releaseDelivery(delivery, callback) {
        this.sendCommand({
            cmd: 'RELEASE',
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock
        }, (err, updated) => {
            if (err) {
                return callback(err);
            }
            callback(null, updated);
        });
    }

    deferDelivery(delivery, ttl, callback) {
        this.sendCommand({
            cmd: 'DEFER',
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock,
            ttl
        }, (err, updated) => {
            if (err) {
                return callback(err);
            }
            callback(null, updated);
        });
    }

    signMessage(delivery) {
        if (!delivery.dkim) {
            return;
        }
        [].concat(delivery.dkim.keys || []).reverse().forEach(key => {
            let dkimHeader;
            dkimHeader = dkimSign.sign(delivery.headers, delivery.dkim.hashAlgo, delivery.dkim.bodyHash, key);
            if (dkimHeader) {
                delivery.headers.addFormatted('dkim-signature', dkimHeader);
            }
        });
    }

    sendBounceMessage(delivery, bounce, smtpResponse) {
        this.sendCommand({
            cmd: 'BOUNCE',
            id: delivery.id,

            from: delivery.from,
            to: delivery.recipient,
            seq: delivery.seq,
            headers: delivery.headers.getList(),

            returnPath: delivery.from,
            category: bounce.category,
            time: Date.now(),
            response: smtpResponse,

            fbl: delivery.fbl
        }, err => {
            if (err) {
                this.close();
                this.emit('error', err);
                log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                return;
            }
        });
    }
}

module.exports = Sender;
