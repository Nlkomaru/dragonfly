// Workers では .wasm を import すると WebAssembly.Module が得られる
// （wrangler の既定ルール CompiledWasm）。TypeScript にその形を教える。
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
