// node/ruby-wasm/ruby-wasm.js
const path = require("path");
const { Worker } = require("worker_threads");

const DEFAULT_CONTINUOUS = true;

module.exports = function(RED) {
    const workerPath = path.join(__dirname, "ruby-worker.js");
    let rubyWorker = null;
    let nextRequestId = 1;
    let activeNodeCount = 0;
    const pendingRequests = new Map();

    function resetWorker(reason) {
        if (!rubyWorker) {
            return;
        }

        const workerToTerminate = rubyWorker;
        rubyWorker = null;

        workerToTerminate.removeAllListeners();
        workerToTerminate.terminate().catch(() => {});

        for (const [, pending] of pendingRequests.entries()) {
            pending.reject(new Error(reason || "Ruby worker reset"));
        }

        pendingRequests.clear();
    }

    function ensureWorker() {
        if (rubyWorker) {
            return rubyWorker;
        }

        rubyWorker = new Worker(workerPath);

        rubyWorker.on("message", (message) => {
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

        rubyWorker.on("error", (err) => {
            resetWorker(`Ruby worker error: ${err.message}`);
        });

        rubyWorker.on("exit", (code) => {
            const reason = code === 0 ? "Ruby worker exited" : `Ruby worker exited with code ${code}`;
            resetWorker(reason);
        });

        return rubyWorker;
    }

    function runRuby(code, onStream) {
        const worker = ensureWorker();
        const id = nextRequestId++;

        return new Promise((resolve, reject) => {
            pendingRequests.set(id, { resolve, reject, onStream });

            try {
                worker.postMessage({ id, code });
            } catch (error) {
                pendingRequests.delete(id);
                resetWorker(`Failed to post message to worker: ${error.message}`);
                reject(error);
            }
        });
    }

    function RubyWasmNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        activeNodeCount += 1;

        node.on("input", async function(msg, send, done) {
            send = send || node.send.bind(node);
            done = done || (() => {});

            if (msg.kill) {
                resetWorker("Killed by user");
                node.status({ fill: "red", shape: "ring", text: "killed" });
                if (done) {
                    done();
                }
                return;
            }

            const streamBuffers = { stdout: "", stderr: "" };

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

                if (flush) {
                    const remainder = streamBuffers[streamType];
                    if (remainder.length) {
                        streamBuffers[streamType] = "";
                        emitLine(streamType, remainder);
                    }
                    return;
                }

                const buffer = streamBuffers[streamType];
                const parts = buffer.split(/\r?\n/);
                streamBuffers[streamType] = parts.pop() ?? "";
                for (const part of parts) {
                    emitLine(streamType, part);
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

                const evaluation = await runRuby(codeToExecute, useContinuous ? (streamType, chunk) => {
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

                if (stdoutOutput) {
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
                if (done) {
                    done();
                }
            } catch (error) {
                processStream("stdout", "", true);
                processStream("stderr", "", true);
                const baseMessage = `Ruby execution error: ${error.message}`;
                node.error(baseMessage, msg);
                if (error.analysis) {
                    node.warn(error.analysis);
                }
                node.status({ fill: "red", shape: "ring", text: statusText("ruby-wasm.status.error", "error") });
                if (done) {
                    done(error);
                }
            }
        });

        node.on("close", function() {
            activeNodeCount = Math.max(0, activeNodeCount - 1);
            if (activeNodeCount === 0) {
                resetWorker("All ruby-wasm nodes closed");
            }
        });
    }

    RED.nodes.registerType("ruby-wasm", RubyWasmNode);
};
