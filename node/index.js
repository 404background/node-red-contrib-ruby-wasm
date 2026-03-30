const rubyWasm = require('./ruby-wasm/ruby-wasm');

module.exports = function(RED) {
    rubyWasm(RED);
};
