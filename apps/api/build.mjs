import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import ts from 'typescript';

/**
 * Production build for the api (ADR-0009 + ADR-0010). Bundles
 * src/main.ts into a single dist/main.js with the workspace packages
 * (@vellum/*) inlined, and leaves real npm deps external so Node
 * resolves them from node_modules at runtime.
 *
 * esbuild does not implement emitDecoratorMetadata, so a tiny loader
 * runs each .ts file through TypeScript's transpileModule first with
 * the metadata flag on. The TS compiler emits the
 * Reflect.metadata('design:paramtypes', ...) calls Nest DI needs for
 * any class with type-based constructor injection (a constructor
 * param without @Inject(token)). The plugin emits ESNext so esbuild's
 * bundler keeps treating imports as ES modules.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@vellum/'));

const tscMetadataPlugin = {
  name: 'tsc-metadata',
  setup(build) {
    const tsOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      useDefineForClassFields: false,
      verbatimModuleSyntax: false,
      isolatedModules: true,
      importHelpers: false,
    };
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      const source = readFileSync(args.path, 'utf8');
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: tsOptions,
        fileName: args.path,
      });
      return { contents: outputText, loader: 'js' };
    });
  },
};

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  sourcemap: true,
  plugins: [tscMetadataPlugin],
  // The bundle is ESM; some transitive code (and Nest's internals)
  // calls require(). createRequire under import.meta.url restores it.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
