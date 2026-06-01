/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // @vellum/core ships TS source with NodeNext-style .js extension
  // imports. transpilePackages compiles the package through SWC; the
  // webpack extensionAlias teaches the bundler to read .js imports as
  // .ts files on disk inside the workspace, which is how NodeNext +
  // bundler-only consumers coexist without a build step in core.
  transpilePackages: ['@vellum/core'],
  webpack: (cfg) => {
    cfg.resolve = cfg.resolve ?? {};
    cfg.resolve.extensionAlias = {
      ...(cfg.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return cfg;
  },
  experimental: {
    typedRoutes: true,
  },
};

export default config;
