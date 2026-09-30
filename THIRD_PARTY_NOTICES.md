# Third-party notices

This package includes source code from the projects below. Each is used under its own license,
reproduced here.

## micro-eth-signer

- Version: 0.19.0
- Source: https://github.com/paulmillr/micro-eth-signer
- Files: `src/core/typed-data.ts` and `src/advanced/abi-mapper.ts`, copied to
  `src/internal/vendor/micro-eth-signer/`. The package does not export these modules, and Hardhat
  computes EIP-712 digests with them, so the plugin uses the same code to get identical results.
- Changes: import paths only. Imports of the package's internal modules now point to its public
  exports.

```text
The MIT License (MIT)

Copyright (c) 2021 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
