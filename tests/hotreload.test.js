'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('ava')
const getPort = require('get-port')
const WebSocket = require('ws')

const server = require('../lib/server')
const registry = require('../lib/registry')

let service
let base
let wsPort
let dirA
let dirB

test.before(async () => {
	dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-ws-a-'))
	dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-ws-b-'))
	fs.writeFileSync(path.join(dirA, 'a.md'), '# A v1\n')
	fs.writeFileSync(path.join(dirB, 'b.md'), '# B v1\n')

	const port = await getPort()
	service = await server.init({
		port,
		address: 'localhost',
		silent: true,
		hotreload: true,
		theme: 'dark'
	})
	base = `http://localhost:${port}`
	wsPort = service.hotReloadServer.address().port
})

test.after.always(() => {
	registry.reset()
	if (service) {
		service.close()
	}
})

// Connects a ws client registered as viewing the given page path and
// resolves with the first message matching the predicate
// fileId mirrors what the page reports for its comments, which differs from
// the id in the URL when the file was reached through a directory registration
const listenFor = (pagePath, predicate, timeoutMs = 5000, fileId = null) => new Promise((resolve, reject) => {
	// 127.0.0.1 explicitly: with parallel test files, "localhost" can resolve
	// to ::1 where an unrelated test server may hold the same port number
	const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`)
	const timer = setTimeout(() => {
		ws.close()
		reject(new Error('timed out waiting for ws message'))
	}, timeoutMs)

	ws.on('open', () => {
		ws.send(JSON.stringify({path: pagePath, fileId}))
	})

	ws.on('message', data => {
		let message
		try {
			message = JSON.parse(data)
		} catch {
			return
		}

		if (predicate(message)) {
			clearTimeout(timer)
			ws.close()
			resolve(message)
		}
	})

	ws.on('error', reject)
})

const settle = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

test.serial('editing a registered file pushes a reload envelope', async t => {
	const {reg} = registry.register(path.join(dirA, 'a.md'))

	const waiting = listenFor(reg.urlPath, message => message.type === 'reload')
	await settle(300) // Let the client register with the ws server

	fs.writeFileSync(path.join(dirA, 'a.md'), '# A v2\n\nnew paragraph\n')

	const message = await waiting
	t.is(message.type, 'reload')
	t.true(message.html.includes('A v2'))
	t.true(message.html.includes('data-source-line'))
})

test.serial('editing a .diff file pushes a reload of its diff block', async t => {
	const diffPath = path.join(dirA, 'change.diff')
	fs.writeFileSync(diffPath, '@@ -1,1 +1,1 @@\n-one\n+two\n')
	const {reg} = registry.register(diffPath)

	// Waits for the edited content specifically: creating the file a moment
	// ago can produce a reload of its own
	const waiting = listenFor(reg.urlPath,
		message => message.type === 'reload' && message.html.includes('+three'))
	await settle(300)

	fs.writeFileSync(diffPath, '@@ -1,1 +1,1 @@\n-one\n+three\n')

	const message = await waiting
	// Rebuilt through the same path the page was rendered with, wrapper included
	t.true(message.html.includes('marker-diffblock'))
	t.true(message.html.includes('+three'))
	t.true(message.html.includes('data-source-line="1"'))
})

test.serial('posting a comment pushes a comments envelope to viewers of that file', async t => {
	const {reg} = registry.register(path.join(dirA, 'a.md'))

	const waiting = listenFor(reg.urlPath, message => message.type === 'comments')
	await settle(300)

	const response = await fetch(`${base}/api/files/${reg.id}/comments`, {
		method: 'POST',
		headers: {'content-type': 'application/json'},
		body: JSON.stringify({line: 1, body: 'ping', author: 'test'})
	})
	t.is(response.status, 201)

	const message = await waiting
	t.is(message.type, 'comments')
	t.is(message.fileId, reg.id)
})

test.serial('comment pushes reach a viewer browsing through a directory registration', async t => {
	const {reg: dirReg} = registry.register(dirA)
	const {reg: fileReg} = registry.register(path.join(dirA, 'a.md'))
	t.not(dirReg.id, fileReg.id)

	// The URL says the directory, the page's comments say the file
	const waiting = listenFor(
		`/f/${dirReg.id}/a.md`,
		message => message.type === 'comments',
		5000,
		fileReg.id)
	await settle(300)

	const response = await fetch(`${base}/api/files/${fileReg.id}/comments`, {
		method: 'POST',
		headers: {'content-type': 'application/json'},
		body: JSON.stringify({line: 1, body: 'from the folder view', author: 'test'})
	})
	t.is(response.status, 201)

	const message = await waiting
	t.is(message.fileId, fileReg.id)
})

test.serial('a change to another file under the same root leaves a viewer alone', async t => {
	const {reg} = registry.register(path.join(dirA, 'a.md'))
	fs.writeFileSync(path.join(dirA, 'sibling.md'), '# sibling v1\n')

	let redrawn = false
	listenFor(reg.urlPath, message => {
		if (message.type === 'reload') {
			redrawn = true
		}

		return false
	}, 1500).catch(() => {})

	await settle(300)
	fs.writeFileSync(path.join(dirA, 'sibling.md'), '# sibling v2\n')
	await settle(1000)

	t.false(redrawn)
})

test.serial('a directory listing redraws when one of its entries changes', async t => {
	const {reg} = registry.register(dirA)

	const waiting = listenFor(`/f/${reg.id}/`, message => message.type === 'reload')
	await settle(300)

	fs.writeFileSync(path.join(dirA, 'a.md'), '# A v4\n')

	const message = await waiting
	t.true(message.html.includes('isfolder'))
})

test.serial('registrations in different directories reload independently', async t => {
	const {reg: regB} = registry.register(path.join(dirB, 'b.md'))

	let leaked = false
	listenFor(regB.urlPath, message => {
		if (message.type === 'reload' && message.html.includes('A v3')) {
			leaked = true
		}

		return false
	}, 1500).catch(() => {})

	await settle(300)
	fs.writeFileSync(path.join(dirA, 'a.md'), '# A v3\n')
	await settle(1000)

	t.false(leaked)
})

test.serial('watchers are removed when the last registration of a root goes away', async t => {
	const {reg} = registry.register(path.join(dirB, 'b.md'))
	registry.unregister(reg.id)

	// A change in dirB must not crash or notify anyone; also re-registering
	// re-creates the watcher and works end to end
	fs.writeFileSync(path.join(dirB, 'b.md'), '# B v2\n')
	await settle(300)

	const {reg: again} = registry.register(path.join(dirB, 'b.md'))
	const waiting = listenFor(again.urlPath, message => message.type === 'reload')
	await settle(300)
	fs.writeFileSync(path.join(dirB, 'b.md'), '# B v3\n')

	const message = await waiting
	t.true(message.html.includes('B v3'))
})
