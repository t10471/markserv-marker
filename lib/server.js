'use strict'

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const chalk = require('chalk')
const connect = require('connect')
const send = require('send')
const WebSocket = require('ws')
const getPort = require('get-port')
const handlebars = require('handlebars')
const MarkdownIt = require('markdown-it')
const mdItAnchor = require('markdown-it-anchor')
const mdItTaskLists = require('markdown-it-task-lists')
const mdItHLJS = require('markdown-it-highlightjs')
const mdItTOC = require('markdown-it-table-of-contents')
const mdItEmoji = require('markdown-it-emoji')
const mdItMathJax = require('markdown-it-mathjax')
const emojiRegex = require('emoji-regex')()

// Building a fence token by hand is how a .diff file reuses the fence
// renderer; lib/rules_block/html_block below is reached for the same reason
const Token = require('markdown-it/lib/token')

const registry = require('./registry')
const sourceLine = require('./source-line')
const mermaidFences = require('./mermaid')
const diffFences = require('./diff-fence')
const linkifyCjk = require('./linkify-cjk')
const createApiHandler = require('./api')

const pkg = require('../package.json')

const style = {
	link: chalk.blueBright.underline.italic,
	address: chalk.greenBright.underline.italic,
	port: chalk.reset.cyanBright,
	pid: chalk.reset.cyanBright
}

const slugify = text => text.toLowerCase().replaceAll(/\s/g, '-')
// Remove punctuations other than hyphen and underscore
	.replaceAll(/[`~!@#$%^&*()+=<>?,./:;"'|{}[\]\\\u2000-\u206F\u2E00-\u2E7F]/g, '')
// Remove emojis
	.replace(emojiRegex, '')
// Remove CJK punctuations
	.replaceAll(/[\u3000。？！，、；：“”【】（）〔〕［］﹃﹄‘’﹁﹂—…－～《》〈〉「」]/g, '')

// External links open in a new tab; relative links and anchors stay in-tab
const externalLinks = markdownIt => {
	const defaultRender = markdownIt.renderer.rules.link_open ||
		((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

	// eslint-disable-next-line camelcase -- markdown-it rule name
	markdownIt.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		const href = tokens[idx].attrGet('href') || ''
		if (/^https?:\/\//i.test(href)) {
			tokens[idx].attrSet('target', '_blank')
			tokens[idx].attrSet('rel', 'noopener noreferrer')
		}

		return defaultRender(tokens, idx, options, env, self)
	}
}

const md = new MarkdownIt({
	linkify: true,
	html: true
})
	.use(mdItAnchor, {slugify})
	.use(mdItTaskLists)
	.use(mdItHLJS)
	.use(mdItEmoji)
	.use(mdItMathJax())
	.use(mdItTOC, {
		includeLevel: [1, 2, 3, 4, 5, 6],
		slugify
	})
	.use(externalLinks)
	// After highlightjs, whose fence renderer it wraps
	.use(sourceLine)
	// After sourceLine, whose fence renderer it wraps in turn
	.use(mermaidFences)
	// After mermaid, so that plugin still wraps the renderer it expects
	.use(diffFences)
	// Corrects where linkify decides a URL ends in Japanese prose
	.use(linkifyCjk)

// Markdown-it 10 evaluates setext headings before html_block, so a comment
// opener whose next line is a ===== ruler parses as <h1><!--</h1> instead of
// an HTML block. CommonMark gives the HTML block precedence and markdown-it
// v11 fixed the rule order; recreate that order by re-registering html_block
// ahead of heading, with the alt list of the original registration so it
// keeps terminating paragraphs.
md.block.ruler.disable('html_block')
md.block.ruler.before('heading', 'html_block_ordered',
	require('markdown-it/lib/rules_block/html_block'),
	{alt: ['paragraph', 'reference', 'blockquote']})

// Only URLs carrying a scheme become links. Left to guess, linkify reads
// README.md as a hostname and links it to http://README.md — and .md, .sh and
// .io are all real TLDs, so a document that names files would be full of them.
// Bare email addresses stay as text for the same reason: nobody asked for them
// to be actionable.
md.linkify.set({fuzzyLink: false, fuzzyEmail: false})

// Markdown Extension Types
const fileTypes = {
	markdown: [
		'.markdown',
		'.mdown',
		'.mkdn',
		'.md',
		'.mkd',
		'.mdwn',
		'.mdtxt',
		'.mdtext',
		'.text'
	],

	html: [
		'.html',
		'.htm'
	],

	// Rendered as a diff block: a page of their own, and the browser can
	// compare the two sides. Served raw they only prompt a download.
	diff: [
		'.diff',
		'.patch'
	],

	watch: [
		'.sass',
		'.less',
		'.js',
		'.css',
		'.json',
		'.gif',
		'.png',
		'.jpg',
		'.jpeg'
	],

	exclusions: [
		'node_modules/',
		'.git/'
	]
}

fileTypes.watch = [...fileTypes.watch, ...fileTypes.markdown, ...fileTypes.html, ...fileTypes.diff]

const materialIcons = require(path.join(__dirname, 'icons', 'material-icons.json'))

const faviconPath = path.join(__dirname, 'icons', 'markserv.svg')
const faviconData = fs.readFileSync(faviconPath)

const log = (str, flags, err) => {
	if (flags.silent) {
		return
	}

	if (str) {
		console.log(str)
	}

	if (err) {
		console.error(err)
	}
}

const msg = (type, msg, flags) =>
	log(chalk`{bgGreen.black   Marker  }{white  ${type}: }` + msg, flags)

const errormsg = (type, msg, flags, err) =>
	log(chalk`{bgRed.white   Marker  }{red  ${type}: }` + msg, flags, err)

const isType = (exts, filePath) => {
	const fileExt = path.parse(filePath).ext
	return exts.includes(fileExt)
}

// YAML frontmatter at the very start of a file: --- ... ---
const frontmatterRe = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

// MarkdownToHTML: turns a Markdown file into HTML content. Frontmatter is
// rendered as a collapsible block instead of being parsed as markdown
// (where the closing --- would turn the last line into a giant heading).
const markdownToHTML = async markdownText => {
	const match = markdownText.match(frontmatterRe)
	if (!match) {
		return md.render(markdownText)
	}

	// Replace the frontmatter with the same number of blank lines so that
	// data-source-line numbers (and thus comment anchors) stay accurate
	const lineCount = match[0].split('\n').length - 1
	const body = '\n'.repeat(lineCount) + markdownText.slice(match[0].length)

	const frontmatterHtml =
		`<details class="frontmatter" open data-source-line="1" data-source-line-end="${lineCount}">` +
		'<summary>frontmatter</summary>' +
		`<pre><code>${md.utils.escapeHtml(match[1])}</code></pre></details>\n`

	return frontmatterHtml + md.render(body)
}

// DiffToHTML: turns a .diff or .patch file into the same block a ```diff fence
// renders as. Built by handing the real fence renderer a token rather than
// emitting the markup here, so the two paths cannot drift apart: the wrapper,
// the highlighting and the line attributes all arrive from the plugin chain.
//
// The whole file is one block starting at line 1, which is what keeps the
// stamped numbers equal to the file's own. Wrapping the content in a synthetic
// fence and parsing that would put every line out by one, and registry.js
// reads the real file to narrow a comment's range.
const diffToHTML = diffText => {
	const count = Math.max(1, diffText.replace(/\n$/, '').split('\n').length)
	const token = new Token('fence', '', 0)
	token.info = 'diff'
	token.content = diffText.endsWith('\n') ? diffText : diffText + '\n'
	// The <pre> takes its attributes from the map, the <code> from these
	token.map = [0, count]
	token.attrSet('data-source-line', '1')
	token.attrSet('data-source-line-end', String(count))

	return md.renderer.rules.fence([token], 0, md.options, {}, md.renderer)
}

// GetFile: reads utf8 content from a file
const getFile = path => fs.promises.readFile(path, 'utf8')

// The index page lists file names, and a tree of index.md files all look the
// same there. The document's own title tells them apart, so it is read off the
// head of the file: a frontmatter `title:` wins, otherwise the first heading.
// Only the head is read — something this far down is not the document's title,
// and the index should not pay to read whole files to draw one column.
const TITLE_SCAN_BYTES = 8192
const TITLE_MAX_CHARS = 120

const tidyTitle = text => text
	.replaceAll(/\[([^\]]+)]\([^)]*\)/g, '$1') // Links keep their text
	.replaceAll('`', '')
	.replaceAll(/[*_]{1,3}(.+?)[*_]{1,3}/g, '$1') // Emphasis markers
	.replaceAll(/\s+/g, ' ')
	.trim()
	.slice(0, TITLE_MAX_CHARS)

const readHead = filePath => {
	const fd = fs.openSync(filePath, 'r')
	try {
		const buffer = Buffer.alloc(TITLE_SCAN_BYTES)
		const read = fs.readSync(fd, buffer, 0, TITLE_SCAN_BYTES, 0)
		const head = buffer.subarray(0, read).toString('utf8')
		// A full buffer means the last line was probably cut, possibly
		// mid-character, so it is not trustworthy
		return read < TITLE_SCAN_BYTES ? head : head.slice(0, head.lastIndexOf('\n') + 1)
	} finally {
		fs.closeSync(fd)
	}
}

const readMarkdownTitle = filePath => {
	if (!isType(fileTypes.markdown, filePath)) {
		return null
	}

	let head
	try {
		head = readHead(filePath)
	} catch {
		// Deleted, unreadable, a directory — the index still has to render
		return null
	}

	const frontmatter = head.match(frontmatterRe)
	if (frontmatter) {
		const declared = frontmatter[1].match(/^title\s*:\s*(.+)$/m)
		if (declared) {
			const value = tidyTitle(declared[1].replaceAll(/^["']|["']$/g, ''))
			if (value) {
				return value
			}
		}
	}

	const lines = (frontmatter ? head.slice(frontmatter[0].length) : head).split(/\r?\n/)
	let inFence = false
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim()
		// A '# comment' inside a fenced block is not a heading
		if (/^(```|~~~)/.test(line)) {
			inFence = !inFence
			continue
		}

		if (inFence || !line) {
			continue
		}

		const atx = line.match(/^#\s+(.+?)\s*#*$/)
		if (atx) {
			return tidyTitle(atx[1]) || null
		}

		// Setext heading: the text is underlined with ===
		if (/^=+$/.test((lines[index + 1] || '').trim())) {
			return tidyTitle(line) || null
		}
	}

	return null
}

const baseTemplate = (templateUrl, handlebarData) => new Promise((resolve, reject) => {
	getFile(templateUrl).then(source => {
		const template = handlebars.compile(source)
		const output = template(handlebarData)
		resolve(output)
	}).catch(reject)
})

const lookUpIconClass = (path, type) => {
	let iconDef

	if (type === 'folder') {
		iconDef = materialIcons.folderNames[path]

		iconDef ||= 'folder'
	}

	if (type === 'file') {
		// Try extensions first
		const ext = path.slice(path.lastIndexOf('.') + 1)
		iconDef = materialIcons.fileExtensions[ext]

		// Then try applying the filename
		iconDef ||= materialIcons.fileNames[path]

		iconDef ||= 'file'
	}

	return iconDef
}

const dirToHtml = filePath => {
	const urls = fs.readdirSync(filePath)

	let list = '<ul>\n'

	for (const subPath of urls) {
		if (subPath.charAt(0) === '.') {
			continue
		}

		const dir = fs.statSync(path.join(filePath, subPath)).isDirectory()
		let href
		if (dir) {
			href = subPath + '/'
			list += `\t<li class="icon folder isfolder"><a href="${href}">${href}</a></li> \n`
		} else {
			href = subPath
			const iconClass = lookUpIconClass(href, 'file')
			list += `\t<li class="icon ${iconClass} isfile"><a href="${href}">${href}</a></li> \n`
		}
	}

	list += '</ul>\n'

	return list
}

// Remove URL params from file being fetched
const getPathFromUrl = url => url.split(/[?#]/)[0]

const secureUrl = url => {
	const encodedUrl = encodeURI(url.replaceAll('%', '%25'))
	return encodedUrl
}

// Create breadcrumb trail tracks, rooted at a registration's URL prefix
const createBreadcrumbs = (relPath, basePrefix, rootLabel) => {
	const crumbs = [{
		href: basePrefix,
		text: rootLabel
	}]

	const dirParts = relPath.replaceAll(/(^\/+|\/+$)/g, '').split('/')
	const urlParts = dirParts.map(part => secureUrl(part))

	if (relPath.length === 0) {
		return crumbs
	}

	let collectPath = basePrefix

	for (const [i, dirName] of dirParts.entries()) {
		const fullLink = collectPath + urlParts[i] + '/'

		const crumb = {
			href: fullLink,
			text: dirName + '/'
		}

		crumbs.push(crumb)
		collectPath = fullLink
	}

	return crumbs
}

const resolveTheme = flags => {
	if (flags.light) {
		return 'light'
	}

	if (flags.synthwave) {
		return 'synthwave'
	}

	if (flags.theme && flags.theme !== 'dark') {
		return flags.theme
	}

	return 'dark'
}

// Resolve a URL path against a root directory, refusing anything that
// escapes the root (path traversal) or smuggles null bytes.
const resolveWithin = (root, urlPath) => {
	if (urlPath.includes('\0')) {
		return null
	}

	const resolved = path.resolve(root, urlPath.replace(/^\/+/, ''))
	if (resolved === root || resolved.startsWith(root + path.sep)) {
		return resolved
	}

	return null
}

const markservUrlLead = '%7Bmarkserv%7D'

// Streams a file with `send`, which expects a URL-encoded path relative to root
const sendFile = (req, res, root, absPath, options = {}) => {
	const urlPath = path.relative(root, absPath)
		.split(path.sep)
		.map(segment => encodeURIComponent(segment))
		.join('/')

	send(req, urlPath, {root, ...options}).pipe(res)
}

// Serves markserv-marker's own bundled assets ({markserv}templates/... URLs)
const createAssetHandler = flags => (req, res, next) => {
	if (!req.url.includes(markservUrlLead)) {
		return next()
	}

	const assetPath = decodeURIComponent(getPathFromUrl(req.url.split(markservUrlLead)[1]))
	const assetFilePath = resolveWithin(__dirname, assetPath)

	if (!assetFilePath) {
		res.writeHead(403)
		res.end()
		return
	}

	if (flags.verbose) {
		msg('{markserv url}', style.link(assetFilePath), flags)
	}

	sendFile(req, res, __dirname, assetFilePath)
}

const createHandlers = flags => {
	const theme = resolveTheme(flags)
	const themeFlags = {
		themeDark: theme === 'dark',
		themeLight: theme === 'light',
		themeSynthwave: theme === 'synthwave',
		themeSolarized: theme === 'solarized'
	}

	const commonTemplateData = {
		pid: process.pid,
		// Every footer names the version, so it belongs here rather than to
		// the one page that used to
		version: pkg.version,
		theme,
		...themeFlags,
		hotreload: flags.$hotreload,
		wsPort: flags.$wsPort
	}

	const errorPage = (res, code, filePath, err, referer) => {
		errormsg(code, filePath, flags, err)

		const templateUrl = path.join(__dirname, 'templates/error.html')

		const handlebarData = {
			...commonTemplateData,
			code,
			fileName: path.parse(filePath).base,
			filePath,
			errorMsg: md.utils.escapeHtml(err.message),
			errorStack: md.utils.escapeHtml(String(err.stack)),
			referer: referer || '/',
			rootDir: filePath
		}

		return baseTemplate(templateUrl, handlebarData).then(final => {
			res.writeHead(code, {
				'content-type': 'text/html; charset=utf-8'
			})
			res.end(final)
		})
	}

	const sendFavicon = res => {
		res.writeHead(200, {'Content-Type': 'image/svg+xml'})
		res.write(faviconData)
		res.end()
	}

	// Comments hang off a registration, whose comment store and snapshot base
	// are one single file (reg.comments / reg.path). A markdown file reached
	// through a directory registration — or through a sibling link under
	// another file's registration — therefore has nowhere to put comments, so
	// it gets a registration of its own here. register() derives its id from
	// the realpath and is idempotent, so revisiting a file reuses it. The URL
	// stays under the registration the reader came in through, keeping
	// breadcrumbs and relative links intact.
	const commentIdFor = (reg, filePath) => {
		if (filePath === reg.path) {
			return reg.id
		}

		try {
			return registry.register(filePath).reg.id
		} catch (error) {
			// A render must not fail because the file could not be registered
			errormsg('register', filePath, flags, error)
			return false
		}
	}

	// A .diff file goes through the same page as markdown: same template, same
	// comment UI, only the content builder differs
	const renderDocument = (kind, toHtml) => (reg, filePath, res) => {
		msg(kind, style.link(filePath), flags)

		return getFile(filePath).then(toHtml).then(content => {
			const templateUrl = path.join(__dirname, 'templates/markdown.html')

			const handlebarData = {
				...commonTemplateData,
				title: path.parse(filePath).base,
				content,
				rootDir: reg.root,
				fileId: commentIdFor(reg, filePath),
				filePath,
				fileUrl: reg.urlPath
			}

			return baseTemplate(templateUrl, handlebarData).then(final => {
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8'
				})
				res.end(final)
			})
		})
	}

	const renderMarkdown = renderDocument('markdown', markdownToHTML)
	const renderDiff = renderDocument('diff', diffToHTML)

	const renderDirectory = (reg, filePath, res) => {
		msg('dir', style.link(filePath), flags)

		const templateUrl = path.join(__dirname, 'templates/directory.html')
		const basePrefix = `/f/${reg.id}/`

		const handlebarData = {
			...commonTemplateData,
			dirname: path.parse(filePath).dir,
			content: dirToHtml(filePath),
			title: path.parse(filePath).base,
			// The strip above the page frame names this folder
			filePath,
			// The served root is the folder itself, which for a file
			// registration is the file's parent: labelling it reg.name gave the
			// folder the file's name, and the path strip now links here
			breadcrumbs: createBreadcrumbs(path.relative(reg.root, filePath), basePrefix,
				(path.parse(reg.root).base || reg.root) + '/'),
			rootDir: reg.root
		}

		return baseTemplate(templateUrl, handlebarData).then(final => {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8'
			})
			res.end(final)
		})
	}

	// Handles /f/<id>/<path-within-root>
	const fileHandler = (req, res) => {
		const decodedUrl = getPathFromUrl(decodeURIComponent(req.url))
		const match = decodedUrl.match(/^\/([^/]+)(\/.*)?$/)

		if (!match) {
			res.writeHead(302, {Location: '/'})
			res.end()
			return
		}

		const reg = registry.get(match[1])
		if (!reg) {
			return errorPage(res, 404, decodedUrl,
				new Error(`Not registered with this daemon: ${match[1]} — see the index at /`))
		}

		const rest = match[2] || '/'
		const filePath = resolveWithin(reg.root, rest)
		if (!filePath) {
			return errorPage(res, 403, decodedUrl,
				new Error('Path escapes the served root directory'))
		}

		if (flags.verbose) {
			msg('request', filePath, flags)
		}

		let stat
		try {
			stat = fs.statSync(filePath)
		} catch (error) {
			if (path.parse(filePath).base === 'favicon.ico') {
				return sendFavicon(res)
			}

			return errorPage(res, 404, filePath, error, path.parse(req.originalUrl).dir + '/')
		}

		if (stat.isDirectory()) {
			if (!decodedUrl.endsWith('/')) {
				res.writeHead(301, {Location: getPathFromUrl(req.originalUrl) + '/'})
				res.end()
				return
			}

			return renderDirectory(reg, filePath, res)
				.catch(error => errorPage(res, 500, filePath, error))
		}

		if (isType(fileTypes.markdown, filePath)) {
			return renderMarkdown(reg, filePath, res)
				.catch(error => errorPage(res, 500, filePath, error))
		}

		if (isType(fileTypes.diff, filePath)) {
			return renderDiff(reg, filePath, res)
				.catch(error => errorPage(res, 500, filePath, error))
		}

		if (isType(fileTypes.html, filePath)) {
			msg('html', style.link(filePath), flags)
			return getFile(filePath).then(html => {
				res.writeHead(200, {'content-type': 'text/html; charset=utf-8'})
				res.end(html)
			}).catch(error => errorPage(res, 500, filePath, error))
		}

		msg('file', style.link(filePath), flags)
		sendFile(req, res, reg.root, filePath, {dotfiles: 'allow'})
	}

	// Handles everything else: the index page at '/', favicon, 404s
	const indexHandler = (req, res) => {
		const pathname = getPathFromUrl(req.url)

		if (pathname === '/favicon.ico') {
			return sendFavicon(res)
		}

		if (pathname !== '/' && pathname !== '') {
			return errorPage(res, 404, pathname,
				new Error('Not found — the daemon only serves registered files (see the index at /)'))
		}

		const allFiles = registry.list()
			.sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1))
			.map(reg => ({
				id: reg.id,
				name: reg.name,
				path: reg.path,
				urlPath: reg.urlPath,
				registeredAt: reg.registeredAt,
				iconClass: reg.type === 'dir' ? 'folder' : lookUpIconClass(reg.name, 'file'),
				isDir: reg.type === 'dir',
				comments: registry.commentCounts(reg.id)
			}))

		const pageSize = 20
		const totalPages = Math.max(1, Math.ceil(allFiles.length / pageSize))
		const requestedPage = Number.parseInt(
			new URL(req.url, 'http://localhost').searchParams.get('page'), 10)
		const page = Math.min(totalPages, Math.max(1, requestedPage || 1))
		// Titles are read from disk, so only the rows actually on this page
		const files = allFiles.slice((page - 1) * pageSize, page * pageSize)
			.map(file => ({
				...file,
				title: file.isDir ? null : readMarkdownTitle(file.path)
			}))

		const templateUrl = path.join(__dirname, 'templates/index.html')
		const handlebarData = {
			...commonTemplateData,
			title: 'markserv-marker',
			port: flags.$httpPort,
			files,
			hasFiles: allFiles.length > 0,
			totalFiles: allFiles.length,
			page,
			totalPages,
			paged: totalPages > 1,
			hasPrev: page > 1,
			hasNext: page < totalPages,
			prevPage: page - 1,
			nextPage: page + 1,
			rootDir: 'index'
		}

		return baseTemplate(templateUrl, handlebarData).then(final => {
			res.writeHead(200, {'content-type': 'text/html; charset=utf-8'})
			res.end(final)
		}).catch(error => errorPage(res, 500, pathname, error))
	}

	return {fileHandler, indexHandler, errorPage}
}

const probeExistingDaemon = (port, flags) => {
	const fail = () => {
		errormsg('port', `port ${port} is in use by another service — choose a different --port`, flags)
		process.exit(1)
	}

	const request = http.get({
		host: flags.address, port, path: '/api/health', timeout: 1000
	}, res => {
		let data = ''
		res.on('data', chunk => {
			data += chunk
		})
		res.on('end', () => {
			try {
				if (JSON.parse(data).name === pkg.name) {
					msg('daemon', `already running on port ${port} — exiting`, flags)
					process.exit(0)
				}
			} catch {}

			fail()
		})
	})

	request.on('error', fail)
	request.on('timeout', () => {
		request.destroy()
		fail()
	})
}

const startHTTPServer = (connectApp, port, flags) => new Promise((resolve, reject) => {
	const httpServer = http.createServer(connectApp)

	httpServer.once('error', error => {
		if (error.code === 'EADDRINUSE' && flags.$exitOnAddrInUse) {
			// Two CLIs raced to start the daemon: if the winner is one of us,
			// bow out quietly so both CLI health polls succeed against it.
			probeExistingDaemon(port, flags)
			return
		}

		reject(error)
	})

	httpServer.listen(port, flags.address, () => resolve(httpServer))
})

const startHotReload = (wsPort, flags) => {
	const wss = new WebSocket.Server({port: wsPort})
	const clients = new Map()

	const parseClientPath = clientPath => {
		const match = getPathFromUrl(clientPath).match(/^\/f\/([^/]+)(\/.*)?$/)
		if (!match) {
			return null
		}

		return {id: match[1], rest: decodeURIComponent(match[2] || '/')}
	}

	// Which registration a viewer's comments live under. Usually the id in its
	// URL, but a markdown file reached through a directory registration is
	// commented on under its own registration, so the page reports that id.
	const commentIds = new Map()

	wss.on('connection', ws => {
		ws.on('message', data => {
			try {
				const msg_ = JSON.parse(data)
				if (msg_.path) {
					clients.set(ws, msg_.path)
				}

				if (msg_.fileId) {
					commentIds.set(ws, msg_.fileId)
				}
			} catch {}
		})

		ws.on('close', () => {
			clients.delete(ws)
			commentIds.delete(ws)
		})
	})

	const sendToClient = (ws, payload) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(payload))
		}
	}

	const broadcastComments = fileId => {
		for (const [ws, clientPath] of clients) {
			const parsed = parseClientPath(clientPath)
			const viewing = commentIds.get(ws) || (parsed && parsed.id)
			if (viewing === fileId) {
				sendToClient(ws, {type: 'comments', fileId})
			}
		}
	}

	const rerenderClient = (ws, reg, rest) => {
		const filePath = resolveWithin(reg.root, rest)
		if (!filePath) {
			return
		}

		let stat
		try {
			stat = fs.statSync(filePath)
		} catch {
			return
		}

		const toHtml = stat.isDirectory() ?
			null :
			(isType(fileTypes.markdown, filePath) && markdownToHTML) ||
			(isType(fileTypes.diff, filePath) && diffToHTML)

		if (toHtml) {
			getFile(filePath)
				.then(toHtml)
				.then(html => sendToClient(ws, {type: 'reload', html}))
				.catch(error => errormsg('hotreload', filePath, flags, error))
		} else if (stat.isDirectory()) {
			try {
				const content = dirToHtml(filePath)
				const breadcrumbs = createBreadcrumbs(
					path.relative(reg.root, filePath), `/f/${reg.id}/`, reg.name + '/')
				let headerHtml = '<h1 class="icon folder isfolder">'
				for (const crumb of breadcrumbs) {
					headerHtml += `<a href="${crumb.href}">${crumb.text}</a>`
				}

				headerHtml += '</h1>\n'
				const footerHtml = '<footer><sup><hr> Served by <a href="https://github.com/markserv/markserv" target="_blank" rel="noopener noreferrer">markserv</a>-marker | <a href="/">index</a> | PID: ' + process.pid + '</sup></footer>'
				sendToClient(ws, {type: 'reload', html: headerHtml + content + footerHtml})
			} catch (error) {
				errormsg('hotreload', filePath, flags, error)
			}
		}
	}

	// A root is a whole directory, so a viewer must not be redrawn for every
	// file underneath it: a page redraws for its own file, a directory listing
	// for the entries it shows. Registering a file at the top of a repository
	// otherwise means a build or a codegen run anywhere in the tree redraws the
	// page, which throws away what the reader was in the middle of typing.
	const isAffected = (reg, rest, changed) => {
		const filePath = resolveWithin(reg.root, rest)
		if (!filePath) {
			return false
		}

		let stat
		try {
			stat = fs.statSync(filePath)
		} catch {
			return false
		}

		// On macOS the watcher reports decomposed names while path.relative
		// gives back what was registered, so compare on one normal form
		const viewed = path.relative(reg.root, filePath).normalize('NFC')
		if (!stat.isDirectory()) {
			return changed.has(viewed)
		}

		const dir = viewed || '.'
		for (const name of changed) {
			if (path.dirname(name) === dir) {
				return true
			}
		}

		return false
	}

	const handleChange = (root, changed) => {
		for (const [ws, clientPath] of clients) {
			if (ws.readyState !== WebSocket.OPEN) {
				continue
			}

			const parsed = parseClientPath(clientPath)
			if (!parsed) {
				continue
			}

			const reg = registry.get(parsed.id)
			if (!reg || reg.root !== root) {
				continue
			}

			if (!isAffected(reg, parsed.rest, changed)) {
				continue
			}

			rerenderClient(ws, reg, parsed.rest)
		}
	}

	// One recursive watcher per registration root, refcounted because several
	// files can be registered out of the same directory
	const watchers = new Map()

	const addRoot = root => {
		const existing = watchers.get(root)
		if (existing) {
			existing.count++
			return
		}

		const entry = {
			count: 1,
			timer: null,
			watcher: null,
			changed: new Set()
		}

		try {
			entry.watcher = fs.watch(root, {recursive: true}, (eventType, filename) => {
				if (!filename) {
					return
				}

				for (const exclusion of fileTypes.exclusions) {
					if (filename.includes(exclusion.replace(/\/$/, ''))) {
						return
					}
				}

				const ext = path.extname(filename)
				if (ext && !fileTypes.watch.includes(ext)) {
					return
				}

				entry.changed.add(filename.normalize('NFC'))
				clearTimeout(entry.timer)
				entry.timer = setTimeout(() => {
					const {changed} = entry
					entry.changed = new Set()
					handleChange(root, changed)
				}, 150)
			})
		} catch (error) {
			errormsg('watch', root, flags, error)
			return
		}

		watchers.set(root, entry)
	}

	const removeRoot = root => {
		const entry = watchers.get(root)
		if (!entry) {
			return
		}

		entry.count--
		if (entry.count <= 0) {
			clearTimeout(entry.timer)
			entry.watcher.close()
			watchers.delete(root)
		}
	}

	const onRegister = reg => addRoot(reg.root)
	const onUnregister = reg => removeRoot(reg.root)

	for (const reg of registry.list()) {
		addRoot(reg.root)
	}

	registry.events.on('register', onRegister)
	registry.events.on('unregister', onUnregister)

	const close = () => {
		registry.events.removeListener('register', onRegister)
		registry.events.removeListener('unregister', onUnregister)
		for (const entry of watchers.values()) {
			clearTimeout(entry.timer)
			entry.watcher.close()
		}

		watchers.clear()
		wss.close()
	}

	return {wss, broadcastComments, close}
}

const logActiveServerInfo = (serveURL, wsPort, flags) => {
	msg('address', style.address(serveURL), flags)

	if (wsPort) {
		msg('hotreload', chalk`{grey ws://localhost:${style.port(wsPort)}}`, flags)
	}

	msg('process', chalk`{grey pid: ${style.pid(process.pid)}}`, flags)
	msg('stop', chalk`{grey POST ${serveURL}/api/shutdown or "markserv-marker stop"}`, flags)
}

const init = async flags => {
	const httpPort = Number(flags.port) || 7642
	flags.$httpPort = httpPort

	let wsPort = null
	const hotreloadEnabled = flags.hotreload !== false && flags.hotreload !== 'false'
	if (hotreloadEnabled) {
		wsPort = await getPort({port: httpPort + 1})
	}

	flags.$wsPort = wsPort
	flags.$hotreload = hotreloadEnabled

	const startedAt = new Date().toISOString()
	const notify = {
		commentChange() {}
	}

	const apiHandler = createApiHandler({
		flags,
		pkg,
		startedAt,
		notify,
		onShutdown: flags.$onShutdown || (() => process.exit(0))
	})

	const {fileHandler, indexHandler} = createHandlers(flags)

	const connectApp = connect()
		.use(createAssetHandler(flags))
		.use('/api', apiHandler)
		.use('/f', fileHandler)
		.use('/', indexHandler)

	const httpServer = await startHTTPServer(connectApp, httpPort, flags)

	let hotReload = null
	if (hotreloadEnabled) {
		hotReload = startHotReload(wsPort, flags)
		notify.commentChange = hotReload.broadcastComments
	}

	const serveURL = 'http://' + flags.address + ':' + httpPort

	logActiveServerInfo(serveURL, wsPort, flags)

	const service = {
		pid: process.pid,
		httpServer,
		hotReloadServer: hotReload ? hotReload.wss : null,
		connectApp,
		serveURL,
		registry,
		notifyCommentChange: fileId => notify.commentChange(fileId),
		close() {
			if (hotReload) {
				hotReload.close()
			}

			httpServer.close()
		}
	}

	return service
}

module.exports = {
	getFile,
	markdownToHTML,
	diffToHTML,
	init
}
