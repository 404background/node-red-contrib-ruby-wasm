// node/ruby-wasm/ruby-worker.js
const { parentPort } = require("worker_threads");
const { WASI } = require("wasi");
const { RubyVM } = require("@ruby/wasm-wasi/dist/vm");
const fs = require("fs/promises");
const path = require("path");

let vmPromise = null;

async function getRubyVM() {
    if (!vmPromise) {
        vmPromise = (async () => {
            const wasi = new WASI({ version: "preview1" });
            // Resolved through the package, not relative to this file: npm
            // hoists dependencies, so in ~/.node-red the package sits next to
            // this one rather than in its own node_modules. Its exports do
            // not list the .wasm file, so it is found from the main entry
            // (dist/cjs/index.js).
            const entry = require.resolve("@ruby/3.4-wasm-wasi");
            const wasmPath = path.join(path.dirname(entry), "..", "ruby+stdlib.wasm");
            const rubyModule = await WebAssembly.compile(await fs.readFile(wasmPath));
            const { vm } = await RubyVM.instantiateModule({ module: rubyModule, wasip1: wasi });
            return vm;
        })().catch((error) => {
            vmPromise = null;
            throw error;
        });
    }
    return vmPromise;
}

function analyzeError(error) {
    const message = typeof error === "string" ? error : (error && error.message) || "";

    if (/unimplemented on this machine/i.test(message) && /timeout/i.test(message)) {
        return "Ruby's Timeout library is not supported in this environment.";
    }

    return null;
}

const CAPTURE_SCRIPT = `
require 'json'
require 'js'

module RubyWasm
    class StreamIO
        attr_reader :buffer

        def initialize(method_name)
            @method_name = method_name
            @buffer = +""
        end

        def write(str)
            chunk = str.to_s
            @buffer << chunk
            begin
                JS.global.call(@method_name, chunk)
            rescue StandardError => e
                # Ignore callback failures
            end
            chunk.bytesize
        end

        def <<(str)
            write(str)
            self
        end

        def flush
            self
        end
    end
end

stdout_stream = RubyWasm::StreamIO.new(:__rubyWasmStdout__)
stderr_stream = RubyWasm::StreamIO.new(:__rubyWasmStderr__)

old_stdout = $stdout
old_stderr = $stderr
$stdout = stdout_stream
$stderr = stderr_stream

value = nil
error_message = nil

begin
    code = JS.global[:__rubyWasmCode__].to_s
    value = eval(code, TOPLEVEL_BINDING, "(ruby-wasm)")
rescue Exception => e
    error_message = "\#{e.class}: \#{e.message}"
    stderr_stream.write(error_message + "\\n")
    stderr_stream.write(e.backtrace.join("\\n") + "\\n") if e.backtrace
ensure
    $stdout = old_stdout
    $stderr = old_stderr
end

JSON.generate({
    "stdout" => stdout_stream.buffer,
    "stderr" => stderr_stream.buffer,
    "result" => value.nil? ? nil : value.to_s,
    "error" => error_message
})
`;

parentPort.on("message", async (message) => {
    const { id, code } = message;

    try {
        const vm = await getRubyVM();

        if (typeof code !== "string") {
            throw new Error("Ruby code must be a string");
        }

        globalThis.__rubyWasmStdout__ = (chunk) => {
            parentPort.postMessage({
                id,
                stream: "stdout",
                chunk: chunk == null ? "" : String(chunk)
            });
        };

        globalThis.__rubyWasmStderr__ = (chunk) => {
            parentPort.postMessage({
                id,
                stream: "stderr",
                chunk: chunk == null ? "" : String(chunk)
            });
        };

        globalThis.__rubyWasmCode__ = code;

        const captureResult = vm.eval(CAPTURE_SCRIPT);
        const captureText = captureResult ? captureResult.toString() : "";

        let payload;
        try {
            payload = JSON.parse(captureText);
        } catch (parseError) {
            parentPort.postMessage({
                id,
                ok: false,
                error: `Failed to parse Ruby output: ${parseError.message}`,
                raw: captureText
            });
            return;
        }

        parentPort.postMessage({
            id,
            ok: true,
            stdout: payload.stdout || "",
            stderr: payload.stderr || "",
            result: payload.result === undefined ? null : payload.result,
            error: payload.error || null
        });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            error: error.message,
            stack: error.stack,
            analysis: analyzeError(error)
        });
    } finally {
        delete globalThis.__rubyWasmCode__;
        delete globalThis.__rubyWasmStdout__;
        delete globalThis.__rubyWasmStderr__;
    }
});
