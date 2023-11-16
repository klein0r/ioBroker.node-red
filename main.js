'use strict';

const utils = require('@iobroker/adapter-core');
const fs = require('node:fs');
const path = require('node:path');
const spawn = require('node:child_process').spawn;
const Notify = require('fs.notify');

function getNodeRedPath() {
    let nodeRed = `${__dirname}/node_modules/node-red`;
    if (!fs.existsSync(nodeRed)) {
        nodeRed = path.normalize(`${__dirname}/../node-red`);
        if (!fs.existsSync(nodeRed)) {
            nodeRed = path.normalize(`${__dirname}/../node_modules/node-red`);
            if (!fs.existsSync(nodeRed)) {
                //adapter && adapter.log && adapter.log.error('Cannot find node-red packet!');
                throw new Error('Cannot find node-red packet!');
            }
        }
    }

    return nodeRed;
}

function getNodeRedEditorPath() {
    let nodeRedEditor = `${__dirname}/node_modules/@node-red/editor-client`;
    if (!fs.existsSync(nodeRedEditor)) {
        nodeRedEditor = path.normalize(`${__dirname}/../@node-red/editor-client`);
        if (!fs.existsSync(nodeRedEditor)) {
            nodeRedEditor = path.normalize(`${__dirname}/../node_modules/@node-red/editor-client`);
            if (!fs.existsSync(nodeRedEditor)) {
                //adapter && adapter.log && adapter.log.error('Cannot find @node-red/editor-client packet!');
                throw new Error('Cannot find @node-red/editor-client packet!');
            }
        }
    }
    return nodeRedEditor;
}

const nodePath = getNodeRedPath();
const editorClientPath = getNodeRedEditorPath();

class NodeRed extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'node-red',
            systemConfig: true,
        });

        this.systemSecret = null;
        this.userDataDir = `${__dirname}/userdata/`;
        this.redProcess = null;

        this.stopping = false;
        this.saveTimer = null;

        this.notificationsFlows = null;
        this.notificationsCreds = null;

        this.attempts = {};
        this.additional = [];

        this.on('ready', this.onReady.bind(this));
        //this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.installLibraries(() => {
            if (this.config.projectsEnabled === undefined) this.config.projectsEnabled = false;
            if (this.config.allowCreationOfForeignObjects === undefined) this.config.allowCreationOfForeignObjects = false;

            // create userData directory
            if (!fs.existsSync(this.userDataDir)) {
                fs.mkdirSync(this.userDataDir);
            }

            this.generateHtml()
                .then(() => {
                    this.syncPublic();

                    // Read configuration
                    this.getObject('flows', (err, obj) => {
                        if (obj && obj.native && obj.native.cred) {
                            const c = JSON.stringify(obj.native.cred);
                            // If really not empty
                            if (c !== '{}' && c !== '[]') {
                                fs.writeFileSync(path.join(this.userDataDir, 'flows_cred.json'), JSON.stringify(obj.native.cred));
                            }
                        }
                        if (obj && obj.native && obj.native.flows) {
                            const f = JSON.stringify(obj.native.flows);
                            // If really not empty
                            if (f !== '{}' && f !== '[]') {
                                fs.writeFileSync(path.join(this.userDataDir, 'flows.json'), JSON.stringify(obj.native.flows));
                            }
                        }

                        this.installNotifierFlows(true);
                        this.installNotifierCreds(true);

                        this.getForeignObject('system.config', (err, obj) => {
                            if (obj && obj.native && obj.native.secret) {
                                this.systemSecret = obj.native.secret;
                                this.log.debug(`Found system secret: ${this.systemSecret}`);
                            } else {
                                this.log.warn('Unable to find system secret in system.config');
                            }

                            // Create settings for node-red
                            this.writeSettings();
                            this.writeStateList(() => this.startNodeRed());
                        });
                    });
                });
        });
    }

    async generateHtml() {
        const searchText = '// THIS LINE WILL BE CHANGED FOR ADMIN';
        const html = fs.readFileSync(`${__dirname}/nodes/ioBroker.html`).toString('utf8');
        const lines = html.split('\n');
        const pos = lines.findIndex(line => line.includes(searchText));
        if (pos) {
            this.log.debug(`Found searched text "${searchText}" of /nodes/ioBroker.html in line ${pos + 1}`);

            // get settings for admin
            const settings = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (settings) {
                // read all admin adapters on this host
                const admins = await this.getObjectViewAsync('system', 'instance', { startkey: 'system.adapter.admin.', endkey: 'system.adapter.admin.\u9999' }, {});
                let admin = admins.rows.find(obj => obj.value.common.host === settings.common.host);

                if (this.config.doNotReadObjectsDynamically) {
                    lines[pos] = `            var socket = null; ${searchText}`;
                } else
                    if (admin && !admin.value.native.auth) {
                        admin = admin.value;
                        if ((!!admin.native.secure) === (!!settings.native.secure)) {
                            lines[pos] = `            var socket = new WebSocket('ws${admin.native.secure ? 's' : ''}://${admin.native.bind === '0.0.0.0' || admin.native.bind === '127.0.0.1' ? `' + window.location.hostname + '` : admin.native.bind}:${admin.native.port}?sid=' + Date.now()); // THIS LINE WILL BE CHANGED FOR ADMIN`;
                        } else {
                            lines[pos] = `            var socket = null; ${searchText}`;
                            this.log.warn(`Cannot enable the dynamic object read as admin is SSL ${admin.native.secure ? 'with' : 'without'} and node-red is ${settings.native.secure ? 'with' : 'without'} SSL`);
                        }
                    } else {
                        lines[pos] = `            var socket = null; ${searchText}`;
                        this.log.warn(`Cannot enable the dynamic object read as admin has authentication`);
                    }
                if (html !== lines.join('\n')) {
                    fs.writeFileSync(`${__dirname}/nodes/ioBroker.html`, lines.join('\n'));
                }
            }
        }
    }

    syncPublic(path) {
        path = path || '/public';
        const dest = editorClientPath + path;

        this.log.debug(`[syncPublic] Src ${path} to ${dest}`);

        const dirs = fs.readdirSync(__dirname + path);

        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest);
        }

        for (const dir of dirs) {
            const sourcePath = `${__dirname + path}/${dir}`;
            const destPath = `${dest}/${dir}`;

            const stat = fs.statSync(sourcePath);
            if (stat.isDirectory()) {
                this.syncPublic(`${path}/${dir}`);
            } else {
                if (!fs.existsSync(destPath)) {
                    fs.createReadStream(sourcePath).pipe(fs.createWriteStream(destPath));
                } else if (dir.endsWith('.js')) {
                    const dest = fs.readFileSync(destPath).toString('utf8');
                    const src = fs.readFileSync(sourcePath).toString('utf8');
                    if (dest !== src) {
                        fs.createReadStream(sourcePath).pipe(fs.createWriteStream(destPath));
                    }
                }

                this.log.debug(`[syncPublic] Copied ${sourcePath} to ${destPath}`);
            }
        }
    }

    installNotifierFlows(isFirst) {
        if (!this.notificationsFlows) {
            const flowsPath = path.join(this.userDataDir, 'flows.json');
            if (fs.existsSync(flowsPath)) {
                if (!isFirst) this.saveObjects();

                // monitor project file
                this.notificationsFlows = new Notify([flowsPath]);
                this.notificationsFlows.on('change', () => {
                    this.saveTimer && this.clearTimeout(this.saveTimer);
                    this.saveTimer = this.setTimeout(this.saveObjects.bind(this), 500);
                });
            } else {
                // Try to install notifier every 10 seconds till the file will be created
                this.setTimeout(() => this.installNotifierFlows(), 10000);
            }
        }
    }

    installNotifierCreds(isFirst) {
        if (!this.notificationsCreds) {
            const flowsCredPath = path.join(this.userDataDir, 'flows_cred.json');
            if (fs.existsSync(flowsCredPath)) {
                if (!isFirst) this.saveObjects();

                // monitor project file
                this.notificationsCreds = new Notify([flowsCredPath]);
                this.notificationsCreds.on('change', () => {
                    this.saveTimer && this.clearTimeout(this.saveTimer);
                    this.saveTimer = this.setTimeout(this.saveObjects.bind(this), 500);
                });
            } else {
                // Try to install notifier every 10 seconds till the file will be created
                this.setTimeout(() => this.installNotifierCreds(), 10000);
            }
        }
    }

    startNodeRed() {
        this.config.maxMemory = parseInt(this.config.maxMemory, 10) || 128;
        const args = [`--max-old-space-size=${this.config.maxMemory}`, path.join(nodePath, 'red.js'), '-v', '--settings', path.join(this.userDataDir, 'settings.js')];

        if (this.config.safeMode) {
            args.push('--safe');
        }

        this.log.info(`Starting node-red: ${args.join(' ')}`);

        this.redProcess = spawn('node', args);
        this.redProcess.on('error', err => this.log.error(`catched exception from node-red:${JSON.stringify(err)}`));
        this.redProcess.stdout.on('data', data => {
            if (!data) {
                return;
            }

            data = data.toString();

            if (data.endsWith('\r\n')) data = data.substring(0, data.length - 2);
            if (data.endsWith('\n\r')) data = data.substring(0, data.length - 2);
            if (data.endsWith('\r')) data = data.substring(0, data.length - 1);
            if (data.endsWith('\n')) data = data.substring(0, data.length - 1);

            if (data.includes('[err')) {
                this.log.error(`Node-RED: ${data}`);
            } else if (data.includes('[warn]')) {
                this.log.warn(`Node-RED: ${data}`);
            } else if (data.includes('[info] [debug:')) {
                this.log.info(`Node-RED: ${data}`);
            } else {
                this.log.debug(`Node-RED: ${data}`);
            }
        });

        this.redProcess.stderr.on('data', data => {
            if (!data) {
                return;
            }
            if (data[0]) {
                let text = '';
                for (let i = 0; i < data.length; i++) {
                    text += String.fromCharCode(data[i]);
                }
                data = text;
            }
            if (data.includes && !data.includes('[warn]')) {
                this.log.warn(data);
            } else {
                this.log.error(JSON.stringify(data));
            }
        });

        this.redProcess.on('exit', (exitCode) => {
            this.log.info(`node-red exited with ${exitCode}`);
            this.redProcess = null;
            if (!this.stopping) {
                this.setTimeout(this.startNodeRed.bind(this), 5000);
            }
        });
    }

    installNpm(npmLib, callback) {
        if (typeof npmLib === 'function') {
            callback = npmLib;
            npmLib = undefined;
        }

        const cmd = `npm install ${npmLib} --production --prefix "${this.userDataDir}" --save`;
        this.log.info(`${cmd} (System call)`);
        // Install node modules as system call

        // System call used for update of js-controller itself,
        // because during installation npm packet will be deleted too, but some files must be loaded even during the install process.
        const exec = require('child_process').exec;
        const child = exec(cmd);
        child.stdout.on('data', buf => this.log.info(buf.toString('utf8')));
        child.stderr.on('data', buf => this.log.error(buf.toString('utf8')));

        child.on('exit', (code) => {
            code && this.log.error(`Cannot install ${npmLib}: ${code}`);
            // command succeeded
            callback && callback(npmLib);
        });
    }

    installLibraries(callback) {
        let allInstalled = true;

        if (typeof this.common.npmLibs === 'string') {
            this.common.npmLibs = this.common.npmLibs.split(/[,;\s]+/);
        }

        // Find userdata directory
        if (this.instance === 0) {
            this.userDataDir = path.join(utils.getAbsoluteDefaultDataDir(), 'node-red');
        } else {
            this.userDataDir = path.join(utils.getAbsoluteDefaultDataDir(), `node-red.${this.instance}`);
        }

        if (this.common && this.common.npmLibs && !this.config.palletmanagerEnabled) {
            this.log.info(`Requested NPM packages: ${JSON.stringify(this.common.npmLibs)}`);
            for (let lib = 0; lib < this.common.npmLibs.length; lib++) {
                if (this.common.npmLibs[lib] && this.common.npmLibs[lib].trim()) {
                    this.common.npmLibs[lib] = this.common.npmLibs[lib].trim();
                    if (!fs.existsSync(path.join(this.userDataDir, `node_modules/${this.common.npmLibs[lib]}/package.json`))) {

                        if (!this.attempts[this.common.npmLibs[lib]]) {
                            this.attempts[this.common.npmLibs[lib]] = 1;
                        } else {
                            this.attempts[this.common.npmLibs[lib]]++;
                        }

                        if (this.attempts[this.common.npmLibs[lib]] > 3) {
                            this.log.error(`Cannot install npm packet: ${this.common.npmLibs[lib]}`);
                            continue;
                        }

                        this.installNpm(this.common.npmLibs[lib], () => setImmediate(() => this.installLibraries(callback)));

                        allInstalled = false;
                        break;
                    } else {
                        if (!this.additional.includes(this.common.npmLibs[lib])) {
                            this.additional.push(this.common.npmLibs[lib]);
                        }
                    }
                }
            }
        }

        allInstalled && callback();
    }

    setOption(line, option, value) {
        const toFind = `'%%${option}%%'`;
        const pos = line.indexOf(toFind);

        if (pos !== -1) {
            let setValue = (value !== undefined) ? value : (this.config[option] === null || this.config[option] === undefined) ? '' : this.config[option];
            if (
                typeof setValue === 'string' &&
                !setValue.startsWith('{') && !setValue.endsWith('}') &&
                !setValue.startsWith('[') && !setValue.endsWith(']')
            ) {
                setValue = setValue.replace(/\\/g, '\\\\');
            }

            return `${line.substring(0, pos)}${setValue}${line.substring(pos + toFind.length)}`;
        }

        return line;
    }

    writeSettings() {
        const config = JSON.stringify(this.systemConfig);
        const text = fs.readFileSync(`${__dirname}/settings.js`).toString();
        const lines = text.split('\n');
        let npms = '\r\n';
        const dir = `${__dirname.replace(/\\/g, '/')}/node_modules/`;
        const nodesDir = `"${__dirname.replace(/\\/g, '/')}/nodes/"`;

        const bind = `"${this.config.bind || '0.0.0.0'}"`;

        let authObj = { type: 'credentials' };
        if ((this.config.authType === undefined) || (this.config.authType === '')) {
            // first time after upgrade or fresh install
            if (this.config.user) {
                this.config.authType = 'Simple';
            } else {
                this.config.authType = 'None';
            }
        }

        switch (this.config.authType) {
            case 'None':
                authObj = { type: 'credentials', users: [], default: { permissions: '*' } };
                break;

            case 'Simple':
                authObj.users = [{ username: this.config.user, password: this.config.pass, permissions: '*' }];
                break;

            case 'Extended':
                authObj.users = this.config.authExt;
                if (this.config.hasDefaultPermissions) {
                    authObj.default = { permissions: this.config.defaultPermissions };
                }
                break;
        }
        const auth = JSON.stringify(authObj);
        this.log.debug(`Writing extended authentication for authType: "${this.config.authType}" : ${JSON.stringify(authObj)}`);

        const pass = `"${this.config.pass}"`;
        const secure = this.config.secure ? '' : '// ';
        const certFile = this.config.certPublic ? path.join(this.userDataDir, `${this.config.certPublic}.crt`) : '';
        const keyFile = this.config.certPrivate ? path.join(this.userDataDir, `${this.config.certPrivate}.key`) : '';
        const hNodeRoot = this.config.httpNodeRoot ? this.config.httpNodeRoot : '/';
        const hStatic = this.config.hStatic === 'true' || this.config.hStatic === true ? '' : '// ';

        for (let a = 0; a < this.additional.length; a++) {
            if (this.additional[a].startsWith('node-red-')) {
                continue;
            }
            npms += `        "${this.additional[a]}": require("${dir}${this.additional[a]}")`;
            if (a !== this.additional.length - 1) {
                npms += ', \r\n';
            }
        }

        // update from 1.0.1 (new convert-option)
        if (this.config.valueConvert === null ||
            this.config.valueConvert === undefined ||
            this.config.valueConvert === '' ||
            this.config.valueConvert === 'true' ||
            this.config.valueConvert === '1' ||
            this.config.valueConvert === 1) {
            this.config.valueConvert = true;
        }
        if (this.config.valueConvert === 0 ||
            this.config.valueConvert === '0' ||
            this.config.valueConvert === 'false') {
            this.config.valueConvert = false;
        }

        // write certificates, if defined
        if (this.config.certPublic && this.config.certPrivate) {
            this.getCertificates((err, certificates) => {
                fs.writeFileSync(certFile, certificates.cert);
                fs.writeFileSync(keyFile, certificates.key);
            });
        }

        for (let i = 0; i < lines.length; i++) {
            lines[i] = this.setOption(lines[i], 'port');
            lines[i] = this.setOption(lines[i], 'auth', auth);
            lines[i] = this.setOption(lines[i], 'pass', pass);
            lines[i] = this.setOption(lines[i], 'secure', secure);
            lines[i] = this.setOption(lines[i], 'certPrivate', keyFile);
            lines[i] = this.setOption(lines[i], 'certPublic', certFile);
            lines[i] = this.setOption(lines[i], 'bind', bind);
            lines[i] = this.setOption(lines[i], 'port');
            lines[i] = this.setOption(lines[i], 'instance', this.instance);
            lines[i] = this.setOption(lines[i], 'config', config);
            lines[i] = this.setOption(lines[i], 'functionGlobalContext', npms);
            lines[i] = this.setOption(lines[i], 'nodesdir', nodesDir);
            lines[i] = this.setOption(lines[i], 'httpAdminRoot');
            lines[i] = this.setOption(lines[i], 'httpNodeRoot', hNodeRoot);
            lines[i] = this.setOption(lines[i], 'hStatic', hStatic);
            lines[i] = this.setOption(lines[i], 'httpStatic');
            lines[i] = this.setOption(lines[i], 'credentialSecret', this.systemSecret);
            lines[i] = this.setOption(lines[i], 'valueConvert');
            lines[i] = this.setOption(lines[i], 'projectsEnabled', this.config.projectsEnabled);
            lines[i] = this.setOption(lines[i], 'palletmanagerEnabled', this.config.palletmanagerEnabled);
            lines[i] = this.setOption(lines[i], 'allowCreationOfForeignObjects', this.config.allowCreationOfForeignObjects);
        }

        const settingsPath = path.join(this.userDataDir, 'settings.js');
        const oldText = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
        const newText = lines.join('\n');
        if (oldText !== newText) {
            fs.writeFileSync(settingsPath, newText);
        }
    }

    writeStateList(callback) {
        this.getForeignObjects('*', 'state', ['rooms', 'functions'], (err, obj) => {
            // remove native information
            for (const i in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, i) && obj[i].native) {
                    delete obj[i].native;
                }
            }

            fs.writeFileSync(`${editorClientPath}/public/iobroker.json`, JSON.stringify(obj));
            callback && callback(err);
        });
    }

    saveObjects() {
        if (this.saveTimer) {
            this.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        let cred = undefined;
        let flows = undefined;

        const flowCredPath = path.join(this.userDataDir, 'flows_cred.json');
        try {
            if (fs.existsSync(flowCredPath)) {
                cred = JSON.parse(fs.readFileSync(flowCredPath, 'utf8'));
            }
        } catch (e) {
            this.log.error(`Cannot read ${flowCredPath}`);
        }
        const flowsPath = path.join(this.userDataDir, 'flows.json');
        try {
            if (fs.existsSync(flowsPath)) {
                flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
            }
        } catch (e) {
            this.log.error(`Cannot save ${flowsPath}`);
        }
        //upload it to config
        this.setObject('flows',
            {
                common: {
                    name: 'Flows for node-red'
                },
                native: {
                    cred: cred,
                    flows: flows
                },
                type: 'config'
            },
            () => this.log.debug(`Save ${flowsPath}`)
        );
    }

    /**
     * @param {ioBroker.Message} msg
     */
    onMessage(msg) {
        if (msg && msg.command) {
            switch (msg.command) {
                case 'update':
                    this.writeStateList(error => msg.callback && this.sendTo(msg.from, msg.command, error, msg.callback));
                    break;

                case 'stopInstance':
                    this.unloadRed();
                    break;
            }
        }
    }

    unloadRed(callback) {
        // Stop node-red
        this.stopping = true;

        if (this.redProcess) {
            this.log.info('kill node-red task');
            this.redProcess.kill();
            this.redProcess = null;
        }

        this.saveTimer && this.clearTimeout(this.saveTimer);

        this.notificationsCreds && this.notificationsCreds.close();
        this.notificationsFlows && this.notificationsFlows.close();

        this.setTimeout(() => callback && callback(), 2000);
    }

    /**
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');

            callback();
        } catch (e) {
            callback();
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new NodeRed(options);
} else {
    // otherwise start the instance directly
    new NodeRed();
}
