import { terser } from 'rollup-plugin-terser';
import typescript from '@rollup/plugin-typescript';
import pkg from './package.json';

const dependencies = Object.assign({}, pkg.dependencies || {}, pkg.peerDependencies || {});

const external = Object.keys(dependencies);

export default [
    {
        input: 'src/index.ts',
        output: {
            dir: 'lib',
            format: 'cjs',
            // exports: 'named',
        },
        external,
        plugins: [typescript({ outDir: 'lib', declaration: true })],
    },
    {
        input: 'src/index.ts',
        output: {
            file: 'lib/index.mjs',
            format: 'esm',
            // exports: 'named',
        },
        external,
        plugins: [typescript()],
    },
    {
        input: 'src/index.browser.ts',
        output: {
            dir: 'lib',
            format: 'umd',
            name: 'ModBus',
            sourcemap: true,
        },
        external,
        plugins: [typescript({ outDir: 'lib', declaration: true }), terser()],
    },
    {
        input: 'src/index.browser.ts',
        output: {
            file: 'lib/index.browser.mjs',
            format: 'esm',
            // exports: 'named',
        },
        external,
        plugins: [typescript()],
    },
];
