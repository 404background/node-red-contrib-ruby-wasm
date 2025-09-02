// node/ruby-wasm/ruby-wasm.js
import { DefaultRubyVM } from "@ruby/wasm-wasi/dist/node";
import fs from "fs/promises";
import path from "path";

async function main(rubyCode) {
  const rubyModule = await WebAssembly.compile(
    await fs.readFile(path.join(process.cwd(), "node_modules/@ruby/wasm-wasi/dist/ruby.wasm")),
  );
  const { vm } = await DefaultRubyVM(rubyModule);
  const result = vm.eval(rubyCode);
  return result.toString();
}

export default function (RED) {
  function RubyWasmNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on("input", async function (msg, send, done) {
      const code = config.code || msg.payload;
      if (typeof code !== "string") {
        node.error("Input code is not a string.");
        if (done) {
          done();
        }
        return;
      }
      try {
        node.status({ fill: "blue", shape: "dot", text: "running" });
        const result = await main(code);
        msg.payload = result;
        send(msg);
        node.status({ fill: "green", shape: "dot", text: "done" });
      } catch (e) {
        node.error(e.message, msg);
        node.status({ fill: "red", shape: "ring", text: "error" });
      }
      if (done) {
        done();
      }
    });
  }
  RED.nodes.registerType("ruby-wasm", RubyWasmNode);
}
