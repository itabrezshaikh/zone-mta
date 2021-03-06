'use strict';

const os = require('os');

module.exports = {

    // If started as root then privileges are dropped after all ports are bound
    // This user must have read+write rights for the leveldb folder
    //user: 'nobody',
    //group: 'nogroup',

    // App name to be used in the Received headers and greeting messages
    name: 'ZoneMTA',

    // App key for process name, syslog ident etc
    ident: 'zone-mta',

    // The user running this server mush have read/write access to the following folders
    queue: {
        // Leveldb folder location. Created if it does not exist
        db: './data/queue'
    },

    // plugin files to load into mailtrain, relative to ./plugins folder
    // such a plugin should expose a method
    plugins: {
        // key is path to plugin to `require` (relative to ./plugins folder), value is the configuration
        // for this plugin. Special keys are `enabled` (if false then the plugin is not loaded)
        // and `ordering`, plugins are enabled in the order of lower ordering keys first
        'user/example-plugin': {
            enabled: false,
            ordering: 123 // lower values are loaded first
        },

        // Make sure messages have all required headers like Date or Message-ID
        'core/default-headers': {
            enabled: ['feeder', 'sender'],
            // If true then delay messages according to the Date header. Messages can be deferred up to 1 year.
            // This only works if the Date header is higher than 5 minutes from now because of possible clock skew
            // This should probably be a separate plugin
            futureDate: false,
            xOriginatingIP: true
        },

        // If authentication is enabled (config.feeder.authentication is true) then make a HTTP
        // request with Authorization:Basic header to the specified URL. If it succeeds (HTTP response code 200),
        // the the user is considered as authenticated
        'core/http-auth': {
            enabled: true,
            url: 'http://localhost:8080/test-auth'
        },

        // Load sender config (eg. DKIM key from a HTTP URL)
        'core/http-config': {
            enabled: true,
            // An URL to check sender configuration from
            url: 'http://localhost:8080/get-config'
        },

        // Validate message dropped to the API
        'core/api-send': {
            enabled: true,
            // How many recipients to allow per message when sending through the API
            maxRecipients: 100
        },

        // Check if recipient MX exists when RCPT TO command is called
        'core/rcpt-mx': false,

        // If enabled then checks message against a Rspamd server
        'core/rspamd': {
            enabled: false, // ['feeder', 'sender'], // spam is checked in 'feeder' context, headers are added in 'sender' context
            url: 'http://localhost:11333/check',
            rejectSpam: true // if false, then the message is passed on with a spam header, otherwise message is rejected
        },

        // Rewrite MAIL FROM address using SRS
        'core/srs': {
            enabled: false, // 'sender', // rewriting is handled in the sending phase
            // secret value for HHH hash
            secret: 'a cat',
            // which domain name to use for the rewritten addresses
            rewriteDomain: 'example.com',
            // which addresses to not rewrite (in addition to addresses for rewriteDomain)
            excludeDomains: ['blurdybloop.com']
        },

        // Send bounce message to the sender
        'core/email-bounce': {
            enabled: false,
            // From: address for the bounce emails
            mailerDaemon: {
                name: 'Mail Delivery Subsystem',
                address: 'mailer-daemon@' + os.hostname()
            },
            sendingZone: 'bounces'
        },

        // POST bounce data to a HTTP URL
        'core/http-bounce': {
            enabled: true,
            // An url to send the bounce information to
            // Bounce notification would be a POST request with the following form fields:
            //   id=delivery id
            //   to=recipient address
            //   returnPath=envelope FROM address
            //   response=server response message
            //   fbl=the value from X-Fbl header
            // If bounce reporting fails (non 2xx response), the notification is retried a few times during the next minutes
            url: 'http://localhost:8080/report-bounce'
        },

        // Send mail addressed to .onion addresses through a SOCKS5 proxy
        'core/onion': {
            enabled: false, //'sender', // routing to the onion network is handled in 'sender' context
            // SOCKS5 proxy host
            host: '127.0.0.1',
            // SOCKS5 proxy port
            port: 9150
                /*
                    // additional config
                    name: 'foobar.onion', // identifier for the EHLO call
                    mtaPort: 25, // MX port to connect to
                    auth: {
                        // authentication for the SOCKS proxy (if needed)
                        username: 'socks user',
                        password: 'socks pass'
                    }
                 */
        }
    },

    // SMTP relay server that accepts messages for the outgoing queue
    feeder: {
        port: 2525,

        // max message size in bytes
        maxSize: 30 * 1024 * 1024, // 30 MB

        // bind to localhost only
        host: '127.0.0.1',

        // Set to false to not require authentication
        // If authentication is enabled then you need to set up an authentication hook,
        // otherwise any username is considered as valid
        authentication: true,

        // if true then do not show version number in SMTP greeting message
        disableVersionString: false,

        // How many recipients to allow per message. This data is handled in batch,
        // so allowing too large lists of recipients might start blocking the thread.
        // 1000 or less recommended but can go up to tens of thousands if needed
        // (you do need to increase the allowed memory for the v8 when using huge recipient lists)
        maxRecipients: 1000,

        starttls: false, // set to true to enable STARTTLS (port 587)
        secure: false // set to true to start in TLS mode (port 465)
            /*
            // define keys for STARTTLS/TLS
            key: './keys/private.key',
            cert: './keys/server.crt'
            */
    },

    dns: {
        // cache lookup results
        caching: true,
        // Sets DNS servers to use for resolving MX/A/AAAA records
        // Use only IP addresses
        //nameservers: ['127.0.0.1'],
        nameservers: false
    },

    // Simple HTTP server for fetching info about messages
    api: {
        port: 8080,
        // bind to localhost only
        host: '127.0.0.1',
        // domain name to access the API server
        hostname: 'localhost',

        // if true, allow posting message data in Nodemailer format to /send
        maildrop: true,

        // hardcoded user credentials for the example authentication URL 'http://localhost:8080/test-auth'
        user: 'zone', // username for the static example auth url
        pass: 'test' // password for the static example auth url
    },

    // Data channel server for retrieving info about messages to be delivered
    queueServer: {
        // Set to false to disable any queue processing. Server would accept messages but would not send anything
        enabled: true,
        port: 8081,
        // bind to localhost only
        host: '127.0.0.1',
        // this is where the clients connect to
        hostname: 'localhost'
    },

    log: {
        // silly, verbose, info, error
        level: 'info',
        // log to syslog if true, otherwise to console
        syslog: true,
        // set to true to see outgoing SMTP transaction log
        mx: false,
        // set to true to see incoming SMTP transaction log
        feeder: false
    },

    /*
        DKIM keys are provided by sender config response.

        Defualt DKIM private keys are stored in ./keys as {DOMAIN}.{SELECTOR}.pem

        For example if you want to use a key for "kreata.ee" with selector "test" then
        the private.key should be available from ./keys/kreata.ee.test.pem

        DKIM signature is based on the domain name of the From: address or if there
        is no From: address then by the domain name of the envelope MAIL FROM:.
        If a matching key can not be found then the message is not signed
     */
    dkim: {
        // If DKIM signing is turned on then body hash is calculated for every message,
        // even if there is no key available for this sender
        enabled: true,
        // Set default hash for the DKIM signature, eg. "sha1" or "sha256". This can be
        // overriden by
        hashAlgo: 'sha256',
        // Key folder for the default keys
        keys: './keys'
    },

    // Sending Zone definitions
    // Every Sending Zone can have multiple IPs that are rotated between connections
    zones: {
        // example default zone
        default: {
            // you can override the SMTP port for testing
            //port: 25,

            // If true then tries IPv6 addresses first when connecting to MX
            preferIPv6: false,

            // If true then does not resolve IPv6 addresses even if these exist.
            // Use it if you can not use IPv6
            ignoreIPv6: true,

            // How many child processes to run for this zone
            processes: 2,
            // How many parallel connections to open for this Sending Zone per process.
            // Local IP addresses from the pool are randomly distributed between
            // the connections.
            connections: 5,

            // Throttling applies per connection in a process
            throttling: '100 messages/second', // max messages per minute, hour or second

            // Define address:name pairs (both IPv4 and IPv6) for outgoing IP addresses
            // This allows you to use different IP addresses for different messages:
            // For example, if you have 5 IP's listed and you open 5 parallel
            // connections against a domain then each of these seems to originate
            // from a different IP address (assuming you can locally bind to these addresses)
            pool: [{
                address: '0.0.0.0',
                name: os.hostname()
            }, {
                address: '::',
                name: os.hostname()
            }]
        },
        // Sending Zone for sending bounce messages
        bounces: {
            preferIPv6: true,
            ignoreIPv6: false,
            connections: 1,
            processes: 1,
            // zone specific logging
            logger: true,
            logLevel: 'silly'

            // * send through next MTA instead of MX
            // port: 587,
            // host: 'smtp.gmail.com',
            // auth: { // optional
            //    user: 'username@gmail.com',
            //    pass: 'ssssss'
            //}
        }
        /*
        loopback: {
            // Another example for a Sending Zone. You probably do not want to use this
            // unless you want all messages to be blocked
            name: 'loopback',
            port: 25,
            preferIPv6: false,
            ignoreIPv6: true,
            connections: 1,
            processes: 1,
            // use all IP addresses provided by this network interface
            interface: 'lo0',
            // All messages that are sent from @localhost addresses are routed through
            // this Sending Zone by default
            senderDomains: ['localhost']
        },
        gmail: {
            port: 25,
            preferIPv6: true,
            ignoreIPv6: false,
            connections: 1,
            processes: 1,
            // zone specific logging
            logger: true,
            logLevel: 'silly',
            // If zone is not specified then use this zone as default for the following recipient domains
            recipientDomains: ['gmail.com', 'kreata.ee'],
            routingHeaders: {
                // use this zone by default if the message includes the following header
                'x-user-id': '123'
            }
        }
        */
    },

    // Domain specific configuration
    // Where "domain" means the domain part of an email address
    domainConfig: {
        // default is required
        default: {
            // How many parallel connections per Sending Zone to use against a recipient domain
            maxConnections: 5
        }
        /*
        'test.tahvel.info': {
            maxConnections: 5
        },
        'hot.ee': {
            maxConnections: 5
        }
        */
    }
};
