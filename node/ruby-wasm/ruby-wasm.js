// node/ruby-wasm/ruby-wasm.js
const path = require("path");
const { Worker } = require("worker_threads");

const DEFAULT_CONTINUOUS = true;
const WORKER_PATH = path.join(__dirname, "ruby-worker.js");

// Terminal animations start each frame by moving the cursor home (ESC[H,
// ESC[1;1H) or clearing the screen (ESC[2J, ESC c). In frame mode each of
// these starts a new message.
const FRAME_START = /\x1b\[(?:[01]?(?:;[01]?)?H|2J)|\x1bc/;
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** The screen a terminal would show for one frame: escape sequences and
 * control characters removed, and text after a carriage return written over
 * the start of its line. */
function renderFrame(text) {
    return text.replace(ANSI_ESCAPE, "").replace(CONTROL, "").split("\n").map((line) => {
        let screen = "";
        for (const part of line.split("\r")) {
            screen = part + screen.slice(part.length);
        }
        return screen;
    }).join("\n");
}

/**
 * One Ruby VM in its own worker thread. Every ruby-wasm node owns one, so
 * what a script defines (globals, methods, classes) stays within its node, and
 * msg.kill stops only that node's run.
 */
function createRubyRunner() {
    let worker = null;
    let nextRequestId = 1;
    const pendingRequests = new Map();

    function reset(reason) {
        if (!worker) {
            return;
        }

        const workerToTerminate = worker;
        worker = null;

        workerToTerminate.removeAllListeners();
        workerToTerminate.terminate().catch(() => {});

        for (const [, pending] of pendingRequests.entries()) {
            pending.reject(new Error(reason || "Ruby worker reset"));
        }

        pendingRequests.clear();
    }

    function ensureWorker() {
        if (worker) {
            return worker;
        }

        worker = new Worker(WORKER_PATH);

        worker.on("message", (message) => {
            const { id } = message;
            const pending = pendingRequests.get(id);
            if (!pending) {
                return;
            }

            if (message.stream) {
                if (typeof pending.onStream === "function") {
                    pending.onStream(message.stream, message.chunk || "");
                }
                return;
            }

            pendingRequests.delete(id);

            if (message.ok) {
                pending.resolve(message);
            } else {
                const error = new Error(message.error || "Ruby worker error");
                if (message.analysis) {
                    error.analysis = message.analysis;
                }
                pending.reject(error);
            }
        });

        worker.on("error", (err) => {
            reset(`Ruby worker error: ${err.message}`);
        });

        worker.on("exit", (code) => {
            const reason = code === 0 ? "Ruby worker exited" : `Ruby worker exited with code ${code}`;
            reset(reason);
        });

        return worker;
    }

    function run(code, onStream) {
        const target = ensureWorker();
        const id = nextRequestId++;

        return new Promise((resolve, reject) => {
            pendingRequests.set(id, { resolve, reject, onStream });

            try {
                target.postMessage({ id, code });
            } catch (error) {
                pendingRequests.delete(id);
                reset(`Failed to post message to worker: ${error.message}`);
                reject(error);
            }
        });
    }

    return { run, reset };
}

module.exports = function(RED) {
    function RubyWasmNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const runner = createRubyRunner();

        node.on("input", async function(msg, send, done) {
            send = send || node.send.bind(node);
            done = done || ((err) => { if (err) { node.error(err, msg); } });

            if (msg.kill) {
                runner.reset("Killed by user");
                node.status({ fill: "red", shape: "ring", text: "killed" });
                done();
                return;
            }

            const streamBuffers = { stdout: "", stderr: "" };
            let useFrames = false;
            let frameCount = 0;
            let screenReset = false;
            let lastFrame = null;

            const statusText = (key, fallback) => {
                const translated = typeof RED._ === "function" ? RED._(key) : null;
                return translated || fallback;
            };

            const emitLine = (streamType, line) => {
                node.status({ fill: "blue", shape: "dot", text: statusText("ruby-wasm.status.streaming", "streaming") });
                const streamMsg = RED.util.cloneMessage(msg);
                streamMsg.rubyStream = streamType;
                streamMsg.payload = line;
                if (streamType === "stderr") {
                    streamMsg.rubyError = line;
                }
                send(streamMsg);
            };

            const emitFrame = (text) => {
                const frame = renderFrame(text);
                // ESC[2J ESC[H and the like leave empty pieces between them
                if (!frame.trim()) {
                    return;
                }
                node.status({ fill: "blue", shape: "dot", text: statusText("ruby-wasm.status.streaming", "streaming") });
                const frameMsg = RED.util.cloneMessage(msg);
                frameMsg.rubyStream = "stdout";
                frameMsg.rubyFrame = ++frameCount;
                frameMsg.payload = frame;
                lastFrame = frame;
                send(frameMsg);
            };

            const processStream = (streamType, chunk, flush = false) => {
                if (typeof chunk !== "string") {
                    chunk = chunk == null ? "" : String(chunk);
                }

                if (!streamBuffers[streamType]) {
                    streamBuffers[streamType] = "";
                }

                if (chunk.length) {
                    streamBuffers[streamType] += chunk;
                }

                const asFrames = useFrames && streamType === "stdout";

                if (flush) {
                    const remainder = streamBuffers[streamType];
                    if (remainder.length) {
                        streamBuffers[streamType] = "";
                        if (asFrames) {
                            emitFrame(remainder);
                        } else {
                            emitLine(streamType, remainder);
                        }
                    }
                    return;
                }

                const buffer = streamBuffers[streamType];
                const parts = buffer.split(asFrames ? FRAME_START : /\r?\n/);
                streamBuffers[streamType] = parts.pop() ?? "";
                if (asFrames && parts.length && !screenReset) {
                    // the first screen replaces what was written before it
                    screenReset = true;
                    parts.shift();
                }
                for (const part of parts) {
                    if (asFrames) {
                        emitFrame(part);
                    } else {
                        emitLine(streamType, part);
                    }
                }
            };

            try {
                node.status({ fill: "blue", shape: "dot", text: statusText("ruby-wasm.status.running", "running") });

                const originalPayload = msg.payload;
                const codeToExecute = config.code || msg.payload;
                if (typeof codeToExecute !== "string") {
                    throw new Error(RED._("ruby-wasm.errors.notString") || "Input code is not a string");
                }

                const useContinuous = msg.continuous !== undefined
                    ? Boolean(msg.continuous)
                    : (config.continuous !== undefined ? Boolean(config.continuous) : DEFAULT_CONTINUOUS);
                // frames are streamed, so frame mode needs continuous mode
                useFrames = useContinuous && Boolean(msg.frames !== undefined ? msg.frames : config.frames);

                const evaluation = await runner.run(codeToExecute, useContinuous ? (streamType, chunk) => {
                    if (streamType === "stdout" || streamType === "stderr") {
                        processStream(streamType, chunk, false);
                    }
                } : undefined);

                if (useContinuous) {
                    processStream("stdout", "", true);
                    processStream("stderr", "", true);
                }

                const stdoutOutput = (evaluation.stdout || "").trim();
                const stderrOutput = (evaluation.stderr || "").trim();
                const resultOutput = evaluation.result !== null && evaluation.result !== undefined
                    ? evaluation.result.toString()
                    : "";

                if (lastFrame !== null) {
                    // all frames joined together would not be readable
                    msg.payload = lastFrame;
                } else if (stdoutOutput) {
                    msg.payload = stdoutOutput;
                } else if (resultOutput && resultOutput.trim()) {
                    msg.payload = resultOutput.trim();
                } else {
                    msg.payload = originalPayload !== undefined ? originalPayload : "";
                }

                if (stderrOutput) {
                    msg.rubyError = stderrOutput;
                } else {
                    delete msg.rubyError;
                }

                if (evaluation.error) {
                    const error = new Error(evaluation.error);
                    if (evaluation.analysis) {
                        error.analysis = evaluation.analysis;
                    }
                    throw error;
                }

                node.status({ fill: "green", shape: "dot", text: statusText("ruby-wasm.status.done", "done") });
                send(msg);
                done();
            } catch (error) {
                processStream("stdout", "", true);
                processStream("stderr", "", true);
                if (error.analysis) {
                    node.warn(error.analysis);
                }
                node.status({ fill: "red", shape: "ring", text: statusText("ruby-wasm.status.error", "error") });
                // done(err) alone reports it: calling node.error as well would
                // trigger Catch nodes twice.
                done(new Error(`Ruby execution error: ${error.message}`));
            }
        });

        node.on("close", function() {
            runner.reset("Node closed");
        });
    }

    RED.nodes.registerType("ruby-wasm", RubyWasmNode);
};
