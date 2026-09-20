'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
	'../htdocs/luci-static/resources/view/status/monitor.js'), 'utf8');
const context = vm.createContext({
	rpc: { declare: () => () => {} },
	L: { toArray: value => value == null ? [] : [].concat(value), naturalCompare: (a, b) => a.localeCompare(b) },
	uci: { sections: () => [ { name: 'wan', network: [ 'wan', 'wan2', 'modem' ] } ],
		get: (config, name) => name == 'modem' ? '0' : null },
	// LuCI owns address parsing; the browser suite exercises its real IPv6 parser.
	validation: { parseIPv4: text => {
		const parts = text.split('.').map(Number);
		return /^\d+\.\d+\.\d+\.\d+$/.test(text) && parts.every(n => n >= 0 && n <= 255) ? parts : null;
	}, parseIPv6: () => null }
});
vm.runInContext(source.slice(0, source.indexOf('return view.extend')), context);

const interfaces = [
	{ interface: 'lan', up: true, device: 'br-lan' },
	{ interface: 'guest', up: true, device: 'br-guest' },
	{ interface: 'wan', up: true, device: 'eth4', l3_device: 'pppoe-wan' },
	{ interface: 'wan6', up: false, device: 'eth4' },
	{ interface: 'wan2', up: true, device: 'eth5' },
	{ interface: 'modem', up: true, device: 'eth6' }
];
const device = (ip, mask = '255.255.255.0') => ({ up: true,
	stats: { rx_bytes: 1000, tx_bytes: 2000 }, ipaddrs: ip ? [ { address: ip, netmask: mask } ] : [] });
const devices = {
	'br-lan': device('192.168.1.1'), 'br-guest': device('192.168.2.1'),
	eth4: device('192.168.100.2'), 'pppoe-wan': device('203.0.113.2', '255.255.255.255'),
	eth5: device('198.51.100.2'), eth6: device('192.168.200.2'),
	eth0: device(), eth1: { ...device(), up: false }
};
const definitions = context.lineDefinitions(interfaces, devices);
const wan = context.wanDevices(interfaces, devices, definitions.groups);
assert.deepEqual(Array.from(wan.names), [ 'eth4', 'eth5' ], 'Connected WANs do not require default routes');

const flow = (src, dst, replySrc = dst, replyDst = src) =>
	`ipv4 2 tcp 6 120 TIME_WAIT src=${src} dst=${dst} sport=12345 dport=443 ` +
	`src=${replySrc} dst=${replyDst} sport=443 dport=12345 mark=0 use=1\n`;
const nat = flow('192.168.1.10', '8.8.8.8', '8.8.8.8', '203.0.113.2');
function counts(text, topology = definitions, counters = devices) {
	const result = context.connectionCounts(text, topology.lines, counters, wan);
	return Object.fromEntries(topology.lines.map(line => [ line.device, result[line.key] ]));
}
let result = counts(nat);
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, 1, 'Upper PPP address maps to the physical WAN row');
assert.equal(result.eth5, 0);
assert.equal(result.eth0, null, 'Unaddressed bridge ports are not assigned bridge counts');
assert.equal(result.eth1, 0);
assert.equal(definitions.lines.filter(line => line.device == 'eth4').length, 1);

result = counts(flow('9.9.9.9', '203.0.113.2', '192.168.1.20', '9.9.9.9'));
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, 1, 'Inbound DNAT belongs to both the WAN and destination LAN');

result = counts(flow('192.168.1.10', '203.0.113.2', '192.168.1.20', '192.168.1.1'));
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, 0, 'Hairpin NAT does not traverse the public WAN');

result = counts(flow('192.168.1.10', '192.168.2.20'));
assert.equal(result['br-lan'], 1);
assert.equal(result['br-guest'], 1);
assert.equal(result.eth4, 0);
assert.equal(counts(flow('192.168.1.10', '192.168.1.1')).eth4, 0);

result = counts(flow('192.168.1.10', '8.8.8.8'));
assert.equal(result['br-lan'], 1);
assert.equal(result.eth4, null, 'Untranslated forwarding cannot be assigned to a WAN by guessing');
assert.equal(result.eth5, null);

const overlapping = { ...devices, extra: device('192.168.1.2') };
result = counts(nat, context.lineDefinitions(interfaces, overlapping), overlapping);
assert.equal(result['br-lan'], null);
assert.equal(result.extra, null);

assert.equal(counts('').eth4, 0);
for (const invalid of [ null, 'truncated', nat.slice(0, 80), nat + 'malformed\n',
	flow('999.168.1.10', '8.8.8.8') ]) {
	result = counts(invalid);
	assert.equal(result['br-lan'], null);
	assert.equal(result.eth4, null);
	assert.equal(result.eth1, 0);
}
const large = nat.repeat(5000);
assert(large.length > 256 * 1024);
assert.equal(counts(large).eth4, 5000);
assert.equal(counts(large)['br-lan'], 5000);

const down = interfaces.map(info => ({ ...info, up: false }));
assert.equal(context.wanDevices(down, devices, context.lineDefinitions(down, devices).groups).names.length, 0);
const sample = context.rates(null, { rx: 100, tx: 100 }, 'eth4', 1000).sample;
assert.equal(context.rates(sample, { rx: 90, tx: 200 }, 'eth4', 2000).rx, 0);
assert.equal(context.rates(sample, { rx: 110, tx: 200 }, 'eth4', 1000).rx, 0);
const addressedInterfaces = interfaces.map(info => ({ ...info,
	...(info.interface == 'lan' ? { 'ipv4-address': [ { address: '192.168.1.1' } ] } : {}),
	...(info.interface == 'wan' ? { 'ipv4-address': [
		{ address: '203.0.113.3', ptpaddress: '203.0.113.1' }, { address: '203.0.113.2' },
		{ address: '203.0.113.2' }, { address: '999.0.0.1' }, { address: '0.0.0.0' },
		null, {}, { address: 123 }, { address: '2001:db8::1' }, { address: '<img>' }
	] } : {}),
	...(info.interface == 'modem' ? { device: 'eth4', 'ipv4-address': [ { address: '192.168.100.2' } ] } : {})
}));
addressedInterfaces.push({ interface: 'wan_6', dynamic: true, up: true, device: 'pppoe-wan',
	'ipv6-address': [ { address: '2001:db8::1' } ] });
const addressLines = context.lineDefinitions(addressedInterfaces, devices).lines;
const wanLine = addressLines.find(line => line.device == 'eth4');
const lanLine = addressLines.find(line => line.device == 'br-lan');
assert.equal(context.lineAddresses(wanLine, devices),
	'modem (192.168.100.2), wan (203.0.113.2, 203.0.113.3)');
assert.equal(context.lineAddresses(lanLine, devices), '192.168.1.1');
assert.equal(context.lineAddresses({ ...wanLine, connected: false }, devices), '');
assert.equal(context.lineAddresses({ ...wanLine, members: [ addressedInterfaces.at(-1) ] }, devices), '',
	'IPv6-only logical interfaces must not borrow an upper device IPv4 address');
const rawLine = addressLines.find(line => line.device == 'eth0');
assert.equal(context.lineAddresses(rawLine, devices), '');
assert.equal(context.lineAddresses(rawLine, { eth0: device('198.51.100.10') }), '198.51.100.10');
assert.equal(context.lineAddresses({ ...rawLine, connected: false }, { eth0: device('198.51.100.10') }), '');
lanLine.members[0]['ipv4-address'] = [ { address: '192.168.1.2' } ];
assert.equal(context.lineAddresses(lanLine, devices), '192.168.1.2');
lanLine.members[0]['ipv4-address'] = {};
assert.equal(context.lineAddresses(lanLine, devices), '');
console.log('Monitor checks passed: connection attribution, WAN rates, IPv4 ownership, deduplication and state changes');

async function refreshChecks() {
	const sent = [], queued = [], snapshots = [], polls = new Map();
	let failedRPC, readGate, readFailure = false, reads = 0, activeReads = 0, maxReads = 0;
	const replies = {
		'system.info': { memory: { total: 100, free: 25 } },
		'network.interface.dump': { interface: [] },
		'luci-rpc.getNetworkDevices': {},
		'file.read': { data: 'cpu 10 0 10 80\n' },
		'file.exec': { code: 1, stdout: '{}' }
	};
	const rpc = { declare: options => (...args) => {
		const key = `${options.object}.${options.method}`;
		// Model LuCI's queue with animation frames suspended: queued RPCs never send.
		if (!options.nobatch) {
			queued.push(key);
			return new Promise(() => {});
		}
		sent.push(key);
		if (key === 'file.read')
			assert.deepEqual(args, [ '/proc/stat' ]);
		if (key === 'file.exec')
			assert.equal(JSON.stringify(args), JSON.stringify([ '/usr/sbin/sensors', [ '-j', '-A' ] ]));
		return Promise.resolve().then(() => {
			if (failedRPC === key)
				throw new Error('RPC unavailable');
			const field = Object.keys(options.expect || {})[0];
			return field ? replies[key][field] : replies[key];
		});
	} };
	Object.assign(context, {
		rpc,
		view: { extend: methods => methods },
		poll: { add: (fn, interval) => polls.set(fn, interval), remove: fn => polls.delete(fn) },
		fs: {
			read: rpc.declare({ object: 'file', method: 'read', expect: { data: '' } }),
			exec: rpc.declare({ object: 'file', method: 'exec' }),
			read_direct: file => {
				assert.equal(file, '/proc/net/nf_conntrack');
				reads++;
				maxReads = Math.max(maxReads, ++activeReads);
				return (readFailure ? Promise.reject(new Error('Read unavailable')) :
					readGate || Promise.resolve('')).finally(() => { activeReads--; });
			}
		}
	});
	Object.assign(context.L, {
		bind: (fn, self) => fn.bind(self),
		resolveDefault: (promise, fallback) => Promise.resolve(promise).catch(() => fallback)
	});
	context.uci.load = () => Promise.resolve();
	const monitor = vm.runInContext('(function() {\n' + source + '\n})()', context);
	const initial = (await monitor.load())[3];
	assert.equal(reads, 0, 'Initialization must not read conntrack');
	assert.equal(initial[3], replies['file.read'].data);
	assert.equal(initial[4].code, 1);
	assert.equal(context.parseSensors(initial[4]).length, 0, 'Valid sensors JSON wins over command exit status');
	Object.assign(monitor, {
		pollSensors: true, pollInterval: 3, refreshRequest: null,
		update: snapshot => snapshots.push(snapshot)
	});
	monitor.pollCallback = monitor.refresh.bind(monitor);
	polls.set(monitor.pollCallback, 3);
	await monitor.refresh();
	await monitor.refresh();
	assert.equal(snapshots.length, 2, 'Repeated refreshes must complete without animation frames');
	assert.equal(queued.length, 0);

	let releaseRead;
	readGate = new Promise(resolve => { releaseRead = resolve; });
	const before = sent.length, readsBefore = reads;
	const pending = monitor.refresh();
	assert.equal(monitor.refresh(), pending);
	for (const interval of [ 1, 60 ]) {
		monitor.handleIntervalChange({ target: { value: String(interval) } });
		assert.equal(polls.size, 1);
		assert.equal(polls.get(monitor.pollCallback), interval);
		assert.equal(monitor.refreshRequest, pending);
	}
	assert.equal(sent.length - before, 5, 'Interval changes share all in-flight snapshot requests');
	assert.equal(reads - readsBefore, 1);
	releaseRead('');
	await pending;
	readGate = null;
	assert.equal(monitor.refreshRequest, null);
	monitor.handleIntervalChange({ target: { value: '1' } });
	assert(monitor.refreshRequest, 'An idle interval change starts an immediate refresh');
	await monitor.refreshRequest;

	failedRPC = 'file.read';
	readFailure = true;
	await monitor.refresh();
	assert.equal(snapshots.at(-1)[3], null);
	assert.equal(snapshots.at(-1)[5], null);
	failedRPC = null;
	readFailure = false;
	await monitor.refresh();
	assert.equal(snapshots.at(-1)[3], replies['file.read'].data);
	assert.equal(snapshots.at(-1)[5], '');
	monitor.update = () => { throw new Error('Update failed'); };
	await assert.rejects(monitor.refresh(), /Update failed/);
	assert.equal(monitor.refreshRequest, null, 'A failed update must release the refresh guard');
	monitor.update = snapshot => snapshots.push(snapshot);
	monitor.pollSensors = false;
	const sensorsBefore = sent.filter(key => key === 'file.exec').length;
	await monitor.refresh();
	assert.equal(sent.filter(key => key === 'file.exec').length, sensorsBefore);
	assert.equal(snapshots.at(-1)[4], null);
	assert.equal(maxReads, 1);
	assert.equal(queued.length, 0);
	Object.assign(monitor, { pollSensors: true, sensorFailures: 0, sensorNodes: {}, sensorKey: '[]' });
	for (const invalid of [ null, { stdout: 'invalid' } ]) {
		monitor.updateSensors(invalid);
		assert.equal(monitor.pollSensors, true);
	}
	monitor.updateSensors(initial[4]);
	assert.equal(monitor.pollSensors, false, 'Valid empty JSON stops probing even with command exit code 1');
	assert.equal(monitor.sensorFailures, 0);
	monitor.pollSensors = true;
	for (let i = 0; i < 3; i++)
		monitor.updateSensors({ stdout: '[]' });
	assert.equal(monitor.pollSensors, false);
	assert.equal(monitor.sensorFailures, 3);
	console.log('Refresh checks passed: paused animation frames, shared requests, interval boundaries, failure recovery and sensors');
}

let refreshDeadline;
Promise.race([
	refreshChecks(),
	new Promise((resolve, reject) => {
		refreshDeadline = setTimeout(() => reject(new Error('Refresh stalled with animation frames paused')), 2000);
	})
]).catch(error => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => clearTimeout(refreshDeadline));
