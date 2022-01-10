import path from "path"
import url from "url"
import dotenv from "dotenv"
dotenv.config()
import {readFileSync} from "fs"
import {Server} from "socket.io"
import express from "express"
import http from "http"
import glob from "glob"
import uniqid from "uniqid"
import {Plugin, PluginManager, Datastore} from "kb2abot"
import {callbackKeys, normalKeys} from "kb2abot/util/fca"
import hook from "kb2abot/deploy/facebook/hook"
import * as Logger from "kb2abot/util/logger"

import devPlugins from "../devPlugins"
import SERVER_CONFIG from "../config"

const app = express()
const httpServer = http.createServer(app)
const io = new Server(httpServer)
const port = process.env.REMOTE_PORT || 1810

// init datastore directory
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
const _import = async u => {
	try {
		return await import(url.pathToFileURL(u))
	} catch (err) {
		Logger.error(err)
		return false
	}
}
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
for (let i = 0; i < devPlugins.length; i++) {
	const plugin = devPlugins[i]
	if (plugin instanceof Plugin) {
		await pluginManager.add(plugin)
		Logger.success(`LOADED ${plugin.package.name}`)
	} else {
		console.log()
		console.log(plugin)
		Logger.warn(
			"This plugin is not an instance of Kb2abot.Plugin, skipping . . ."
		)
	}
}

// register internal plugin
for (const plugin of pluginManager)
	if (plugin.isInternal) plugin.pluginManager = pluginManager

httpServer.listen(port, () =>
	Logger.success("Plugin server started on port: *" + port)
)

io.on("connection", async socket => {
	const register = {}
	const remoteApi = createRemoteAPI(register, socket)

	socket.on("api-request-bot", async request => {
		const sendBack = (result, success = true) => {
			socket.emit("bot-response-api", {
				request,
				result,
				success
			})
			console.log("Bot reponse to api: ", result)
		}
		switch (request.command) {
		case "handleMessage":
			try {
				sendBack(
					await hook.bind({
						api: remoteApi,
						config: SERVER_CONFIG,
						pluginManager
					})(undefined, request.args[0])
				)
			} catch (err) {
				sendBack(err.stack, false)
			}
			break
		}

		// switch (request.command) {
		// case "findCommands":
		// 	{
		// 		/*
		// 		const [address] = request.args
		// 		const commands = pluginManager.map(plugin => plugin.commands.recursiveFind(address)).flat()
		// 		sendBack(commands.map(c => c.serialize()))
		// 		 */

		// 		const userid = await remoteApi.getCurrentUserID()
		// 		sendBack({ userid })
		// 		break
		// 	}
		// case "getAllPlugins"
		// sendBack(pluginManager.map(plugin => plugin.serialize()))
		// break
		// case "executeCommand":
		// 	{
		// 		const [address, threadID, message] = request.args
		// 		const thread = await getThread(message.threadID)
		// 		const commands = pluginManager.map(plugin => plugin.commands.recursiveFind(address)).flat()
		// 		commands[0].onCall

		// 		break
		// 	}
		// }
	})

	socket.on("api-response-bot", ({request, result, success}) => {
		if (register[request.id]) {
			clearTimeout(register[request.id].timeout)
			if (success) register[request.id].resolve(result)
			else register[request.id].reject(result)
			delete register[request.id]
		}
	})

	try {
		socket.data.userID = await remoteApi.getCurrentUserID()
		Logger.success(`User ${socket.data.userID} connected!`)
	} catch (err) {
		Logger.warn("Someone has connected but cannot retreive userID!")
		return socket.disconnect()
	}

	socket.on("disconnect", () => {
		Logger.warn(`User ${socket.data.userID} disconnected!`)
	})
})

function createRemoteAPI(register, socket) {
	const executeMethod = (method, ...args) => {
		return new Promise((resolve, reject) => {
			const msg = new RemoteCommand(method, args)
			const timeout = setTimeout(() => {
				if (!register[msg.id]) return
				delete register[msg.id]
				reject("Remote api timeout!")
			}, process.env.REMOTE_TIMEOUT)
			register[msg.id] = {resolve, reject, timeout}
			socket.emit("bot-request-api", msg)
			console.log("Bot request to api: ", msg)
		})
	}
	const functions = {}
	callbackKeys.push("sendMessage")
	for (const method of callbackKeys)
		functions[method] = (...args) => executeMethod(method, ...args)
	for (const method of normalKeys)
		functions[method] = (...args) => executeMethod(method, ...args)

	functions.ping = (timeNow = Date.now()) => executeMethod("ping", timeNow)
	return functions
}

class RemoteCommand {
	id = uniqid();
	constructor(command, args) {
		this.command = command
		this.args = args
	}
}
