# node-red-contrib-ruby-wasm

A Node-RED node that executes Ruby code using WebAssembly.

## Installation

```bash
npm install node-red-contrib-ruby-wasm
```

## Features

- **Ruby WebAssembly Execution**: Execute Ruby code in a sandboxed WebAssembly environment
- **Simple Output**: Ruby `puts`, `print`, and `<<` statements are captured to `msg.payload`
- **Continuous Mode**: Stream output in real time (default) or buffer until completion when disabled
- **Rich Editor**: ACE editor with Ruby syntax highlighting
- **No Dependencies**: Self-contained Ruby environment

## Usage

### Basic Example

```ruby
# Output using puts (goes to msg.payload)
puts "Hello from Ruby!"
puts "Current time: #{Time.now}"
```

### Return Value

```ruby
# Return value (goes to msg.payload if no puts output)
result = 10 + 20
"Calculation result: #{result}"
```

### String Processing

```ruby
# String manipulation
text = "Hello World"
processed = text.upcase.reverse
puts "Processed: #{processed}"
```

### Mathematical Operations

```ruby
# Array processing
numbers = [1, 2, 3, 4, 5]
sum = numbers.sum
average = sum.to_f / numbers.length
puts "Sum: #{sum}, Average: #{average}"
```

## Output Priority

1. **puts output** - Captured and sent to `msg.payload`
2. **Return value** - Used if no puts output
3. **Original payload** - Preserved if no output

## Control

- **Continuous mode**: `msg.continuous = true` (default) streams output as it is produced. Set to `false` to buffer and emit once after completion.
- **Kill**: Send `msg.kill = true` to immediately terminate the Ruby execution running in this node. Other ruby-wasm nodes are not affected.

## Isolation

Each ruby-wasm node runs its own Ruby VM in a worker thread. Global variables, methods and classes a script defines stay within that node: they are kept for the node's next run, but other ruby-wasm nodes do not see them. Killing a node, or redeploying it, starts a fresh VM.

Errors are reported once through the node's `done(err)`, so a Catch node receives each failure once.

## Streaming Output

The node supports real-time streaming of standard output. This is useful for long-running tasks or animations.

- **Supported Methods**: `puts`, `print`, `$stdout <<`, and `printf` all trigger streaming events.
- **Mode**:
  - Continuous **on** (default): emits each chunk immediately; you receive multiple messages during execution.
  - Continuous **off**: buffers output and emits a single message after execution finishes.
- **Message Structure (when streaming)**: Streaming messages contain:
  - `msg.payload`: The chunk of text output
  - `msg.rubyStream`: `"stdout"` or `"stderr"`
- **Final Message**: After execution completes, a final message is sent with the accumulated output (or return value).

### Streaming Example

```ruby
# This will emit 3 messages with 1 second delay between them
3.times do |i|
  puts "Processing item #{i+1}..."
  sleep 1
end
"Done"
```

### Advanced Output

You can use standard Ruby output methods:

```ruby
# Using print (no newline)
print "Loading"
5.times do
  sleep 0.2
  print "."
end
puts " Done!"

# Using << operator
$stdout << "Direct " << "write " << "to " << "stdout\n"
```

## Ruby Capabilities

- **Full Language Support**: Classes, modules, blocks, lambdas, and metaprogramming
- **Standard Library**: String, Array, Hash, Math, Time, JSON, etc.
- **Complex Logic**: Capable of running complex algorithms and obfuscated code (e.g., ASCII art animations)
- **Sandboxed**: File system access is restricted to the WASM environment

## Examples

The `examples` folder contains test flows:

- **`simple-test-flow.json`** - Basic functionality tests
- **`basic-example-flow.json`** - Simple usage example

Import these flows to see the node in action.

## Troubleshooting

1. **Installation Issues**: Ensure all dependencies are installed with `npm install`
2. **No Output**: Check that your Ruby code uses `puts` or returns a value
3. **Ruby Errors**: Check Node-RED debug panel for error messages
4. **Long-Running Scripts**: Use `msg.kill = true` to abort execution early if needed. Continuous mode can be turned off to buffer output until completion.

Note: Some Ruby gems and advanced I/O operations may not be available in the WebAssembly environment.

## Dependencies

This node uses:
- `@ruby/wasm-wasi`: WebAssembly Ruby runtime
- `@ruby/3.4-wasm-wasi`: Ruby 3.4 WebAssembly build

## Development

To contribute to this project:

1. Clone the repository
2. Install dependencies: `npm install`
3. Link for local development: `npm link`
4. In your Node-RED user directory: `npm link @background404/node-red-contrib-ruby-wasm`

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions, please visit: https://github.com/404background/node-red-contrib-ruby-wasm/issues
