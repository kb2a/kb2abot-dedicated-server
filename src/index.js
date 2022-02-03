import path from "path"
import url from "url"
import dotenv from "dotenv"
dotenv.config()
import {readFileSync} from "fs"
import {Server} from "socket.io"
import express from "express"
import http from "http"
import glob from "glob"
import fetch from "node-fetch"
import {Server as PromiseIO} from "promise-socket.io"
import {Plugin, PluginManager, Datastore} from "kb2abot"
import {callbackKeys, normalKeys, stringifyAppstate} from "kb2abot/util/fca"
import hook from "kb2abot/deploy/facebook/hook"
import * as Logger from "kb2abot/util/logger"

import devPlugins from "../devPlugins"
import SERVER_CONFIG from "../config"
import * as Label from "./label"

const app = express()
const httpServer = http.createServer(app)
const io = new Server(httpServer)
const promiseIO = new PromiseIO(io)
const port = process.env.REMOTE_PORT || 1810

// init datastore directory
Logger.log("Initing datastore")
Datastore.init("datastores")

const pluginManager = new PluginManager("config", "userdata")

// load plugins from "plugins" folder
const pluginMiniMatch = url.fileURLToPath(
	path.join(import.meta.url, "../../plugins/**/package.json")
)
const pkgPaths = glob.sync(pluginMiniMatch) // current cwd is "kb2abot-bootloader/src/cluster-bot"
if (pkgPaths.length == 0)
	Logger.warn(
		`No plugins found at ${pluginMiniMatch}, make sure you are passing valid directory!`
	)
else Logger.log(`Found ${pkgPaths.length} plugins at /plugins`)
const _import = async u => {
	try {
		return await import(url.pathToFileURL(u))
	} catch (err) {
		Logger.error(err)
		return false
	}
}
Logger.log("Loading plugins at /plugins")
const loads = (
	await Promise.all(
		pkgPaths.map(pth => {
			const pkg = JSON.parse(readFileSync(pth).toString())
			if (pkg.main) return _import(path.resolve(pth, "..", pkg.main))
			return _import(path.resolve(pth, "../index.js"))
		})
	)
).filter(plugin => plugin)
for (let i = 0; i < loads.length; i++) {
	const plugin = new loads[i].default()
	await pluginManager.add(plugin)
	Logger.success(
		`LOADED ${plugin.package.name} [${plugin.commands.childLength} cmds]`
	)
}

// load plugins export from root/devPlugins.js (plugins added by hand)
Logger.log("Loading plugins instance at ./devPlugins.js")
for (let i = 0; i < devPlugins.length; i++) {
	const plugin = devPlugins[i]
	await pluginManager.add(plugin)
	Logger.success(`LOADED ${plugin.package.name}`)
}

// register internal plugin
for (const plugin of pluginManager)
	if (plugin.isInternal) plugin.pluginManager = pluginManager

Logger.log("Setting up socket.io server")
promiseIO.onConnection(async socket => {
	const remoteFca = createRemoteFCA(socket)
	try {
		socket.data.userID = await remoteFca.getCurrentUserID()
		Logger.success(`User ${socket.data.userID} connected!`)
	} catch (err) {
		Logger.error(err)
		Logger.warn("Someone has connected but cannot retreive userID!")
		return socket.disconnect()
	}

	try {
		for (const plugin of pluginManager) await plugin.onLogin(remoteFca)
	} catch (err) {
		Logger.error("Error while triggering onLogin events")
		Logger.error(err)
	}

	socket.onPromise("handleMessage", async message => {
		return await hook.bind({
			api: remoteFca,
			config: SERVER_CONFIG,
			pluginManager
		})(undefined, message)
	})

	socket.on("disconnect", () => {
		Logger.warn(`User ${socket.data.userID} disconnected!`)
	})
})

function createRemoteFCA(socket) {
	const functions = {}
	callbackKeys.push("sendMessage")
	for (const method of [].concat(callbackKeys, normalKeys))
		functions[method] = (...args) => socket.emitPromise("fca", method, args)

	functions.fetch = async (url, noHeadersOption = {}, extendedHeaders = {}) => {
		const cookie = stringifyAppstate(await functions.getAppState())
		return await fetch(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_2) AppleWebKit/600.3.18 (KHTML, like Gecko) Version/8.0.3 Safari/600.3.18",
				cookie,
				...extendedHeaders
			},
			...noHeadersOption
		})
	}

	functions.getToken = async () => {
		const data = await (
			await functions.fetch("https://business.facebook.com/business_locations")
		).text()
		const first = /LMBootstrapper(.*?){"__m":"LMBootstrapper"}/.exec(data)[1]
		const second = /"],\["(.*?)","/.exec(first)[1]
		return second
	}

	// send exclusive commands (not belong to fca methods)
	functions.socket = socket

	return functions
}

Logger.log("Creating interval for saving datastore")
setInterval(() => {
	for (const plugin of pluginManager) pluginManager.saveDatastore(plugin)
	Logger.success("Saved datastore successfully!")
}, SERVER_CONFIG.datastoreInterval || 1000 * 60 * 60 * 1)

httpServer.listen(port, () =>
	Logger.success("Plugin server started on port: *" + port)
)
