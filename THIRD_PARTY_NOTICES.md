# Third-Party Notices

This project (`sema-core`) redistributes and depends on the open-source software listed below. Each component is licensed under its own terms; the original copyright notices and license texts ship with the corresponding package in `node_modules/<package>/LICENSE` and remain authoritative.

`sema-core` itself is licensed under the MIT License — see [LICENSE](./LICENSE).

## License Summary

| License | Count |
| --- | --- |
| MIT | 212 |
| ISC | 8 |
| BSD-3-Clause | 6 |
| BlueOak-1.0.0 | 6 |
| BSD-2-Clause | 3 |
| Apache-2.0 | 2 |
| MIT* | 1 |
| (MIT AND Zlib) | 1 |
| 0BSD | 1 |
| **Total** | **240** |

All dependencies use permissive licenses (MIT / ISC / BSD / Apache-2.0 / BlueOak-1.0.0 / 0BSD). No copyleft (GPL / AGPL / LGPL) licenses are introduced.

## Direct Dependencies

| Package | Version | License | Repository |
| --- | --- | --- | --- |
| `@anthropic-ai/sdk` | 0.39.0 | MIT | https://github.com/anthropics/anthropic-sdk-typescript |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `@vscode/ripgrep` | 1.17.1 | MIT | https://github.com/microsoft/vscode-ripgrep |
| `cron-parser` | 5.5.0 | MIT | https://github.com/harrisiirak/cron-parser |
| `diff` | 7.0.0 | BSD-3-Clause | https://github.com/kpdecker/jsdiff |
| `events` | 3.3.0 | MIT | https://github.com/Gozala/events |
| `glob` | 13.0.6 | BlueOak-1.0.0 | https://github.com/isaacs/node-glob |
| `gray-matter` | 4.0.3 | MIT | https://github.com/jonschlinkert/gray-matter |
| `iconv-lite` | 0.6.3 | MIT | https://github.com/ashtuchkin/iconv-lite |
| `iconv-lite` | 0.7.2 | MIT | https://github.com/pillarjs/iconv-lite |
| `jimp` | 0.22.12 | MIT | https://github.com/jimp-dev/jimp |
| `lodash-es` | 4.18.1 | MIT | https://github.com/lodash/lodash |
| `lru-cache` | 11.3.5 | BlueOak-1.0.0 | https://github.com/isaacs/node-lru-cache |
| `nanoid` | 5.1.9 | MIT | https://github.com/ai/nanoid |
| `openai` | 6.34.0 | Apache-2.0 | https://github.com/openai/openai-node |
| `shell-quote` | 1.8.3 | MIT | https://github.com/ljharb/shell-quote |
| `spawn-rx` | 5.1.2 | MIT | https://github.com/anaisbetts/spawn-rx |
| `undici` | 7.25.0 | MIT | https://github.com/nodejs/undici |
| `zod-to-json-schema` | 3.25.2 | ISC | https://github.com/StefanTerdell/zod-to-json-schema |
| `zod` | 3.25.76 | MIT | https://github.com/colinhacks/zod |

## Transitive Dependencies

The full transitive dependency list (~240 packages) is authoritatively tracked in `package-lock.json`. To regenerate an audit snapshot with each package's resolved version and license, run the command below.

## External Services

`sema-core` may issue requests to the following external services on behalf of the application that embeds it. Use of each service is governed by the respective provider's terms — `sema-core` itself does not redistribute their proprietary content or models.

- **Anthropic API** — via `@anthropic-ai/sdk`. See https://www.anthropic.com/legal/commercial-terms
- **OpenAI API** — via `openai`. See https://openai.com/policies/
- **Model Context Protocol (MCP) servers** — via `@modelcontextprotocol/sdk`. Each MCP server has its own terms; consult the individual server's documentation.
- **Other OpenAI-compatible endpoints** (e.g., Alibaba Cloud DashScope, Volcano Engine Ark) reachable through the `openai` client are subject to their respective provider terms.

## How to Regenerate

```bash
npx license-checker --production --json > licenses.json
```
