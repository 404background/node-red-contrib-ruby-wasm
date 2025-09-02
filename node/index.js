// node/index.js
import rubyWasm from "./ruby-wasm/ruby-wasm.js";

export default function (RED) {
  rubyWasm(RED);
}
