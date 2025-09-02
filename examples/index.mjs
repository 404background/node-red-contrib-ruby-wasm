import fs from "fs/promises";
import { WASI } from "wasi";
import { RubyVM } from "@ruby/wasm-wasi/dist/vm";

const wasi = new WASI({ 
    version: "preview1", 
    stderr: 0
});

const binary = await fs.readFile("./node_modules/@ruby/3.4-wasm-wasi/dist/ruby.wasm");
const module = await WebAssembly.compile(binary);
const { vm } = await RubyVM.instantiateModule({ module, wasip1: wasi });
vm.eval(`puts "hello world"`);
