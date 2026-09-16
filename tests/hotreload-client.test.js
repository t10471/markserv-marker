'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

// The hot-reload client is inline in the page, so it is read out of the
// template rather than kept as a second copy here
const TEMPLATE = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'markdown.html'), 'utf8')

const wsClient = () => {
	const match = TEMPLATE.match(/{{#if hotreload}}\s*<script>([\S\s]*?)<\/script>/)
	if (!match) {
		throw new Error('the hot-reload script block is gone from markdown.html')
	}

	return match[1].replace('{{wsPort}}', '7643')
}

const FORM = '<div class="marker-form" data-marker-ui="">'
	+ '<textarea class="marker-textarea"></textarea></div>'

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

// Builds a page running the hot-reload client with its socket mocked, so a
// server push is a direct call to onmessage
const buildPage = () => {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<div id="marker-content"><p>v1</p>${FORM}</div>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	const events = []
	const sockets = []

	window.WebSocket = function () {
		const socket = {readyState: 1, send() {}}
		sockets.push(socket)
		return socket
	}

	window.document.addEventListener('marker:reload', () => events.push('reload'))
	window.document.addEventListener('marker:comments', () => events.push('comments'))
	window.eval(wsClient())

	const push = payload => sockets.at(-1).onmessage({data: JSON.stringify(payload)})
	return {document: window.document, events, push}
}

test('a push redraws the content when nobody is typing', t => {
	const {document, push, events} = buildPage()

	push({type: 'reload', html: '<p>v2</p>'})

	t.true(document.querySelector('#marker-content').innerHTML.includes('v2'))
	t.deepEqual(events, ['reload'])
})

test('a push is held while a comment is being written, then applied on leaving', async t => {
	const {document, push, events} = buildPage()
	const textarea = document.querySelector('.marker-textarea')
	textarea.focus()
	textarea.value = 'half-written'

	push({type: 'reload', html: '<p>v2</p>'})
	await tick(20)

	const content = document.querySelector('#marker-content')
	t.false(content.innerHTML.includes('v2'))
	t.is(document.querySelector('.marker-textarea').value, 'half-written')
	t.deepEqual(events, [])

	textarea.blur()
	await tick(20)

	t.true(content.innerHTML.includes('v2'))
	t.deepEqual(events, ['reload'])
})

test('a comments push is held the same way', async t => {
	const {document, push, events} = buildPage()
	const textarea = document.querySelector('.marker-textarea')
	textarea.focus()

	push({type: 'comments', fileId: 'abc123'})
	await tick(20)
	t.deepEqual(events, [])

	textarea.blur()
	await tick(20)
	t.deepEqual(events, ['comments'])
})

test('only the newest held push is applied', async t => {
	const {document, push, events} = buildPage()
	const textarea = document.querySelector('.marker-textarea')
	textarea.focus()

	push({type: 'reload', html: '<p>v2</p>'})
	push({type: 'reload', html: '<p>v3</p>'})
	await tick(20)

	textarea.blur()
	await tick(20)

	const content = document.querySelector('#marker-content')
	t.true(content.innerHTML.includes('v3'))
	t.false(content.innerHTML.includes('v2'))
	t.deepEqual(events, ['reload'])
})
