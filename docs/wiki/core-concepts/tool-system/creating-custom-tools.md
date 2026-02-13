# 创建自定义工具

扩展 Sema 工具能力有两种方式：**MCP 工具**（推荐）和**代码级扩展**。

## 方式一：通过 MCP 创建工具（推荐）

MCP 是最灵活的扩展方式，无需修改核心代码，支持任意语言实现：

1. 创建 MCP 服务器（以 Node.js 为例）：

```javascript
// my-mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new Server({ name: 'my-tools', version: '1.0.0' })

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'fetch_weather',
      description: '获取指定城市的天气信息',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称' },
        },
        required: ['city'],
      },
    },
  ],
}))

server.setRequestHandler('tools/call', async ({ name, arguments: args }) => {
  if (name === 'fetch_weather') {
    const weather = await getWeather(args.city)
    return { content: [{ type: 'text', text: JSON.stringify(weather) }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

2. 注册到 Sema：

```javascript
await sema.addOrUpdateMCPServer({
  name: 'my-tools',
  transport: 'stdio',
  command: 'node',
  args: ['my-mcp-server.js'],
}, 'user')
```

3. 工具自动可用，命名为 `mcp__my-tools__fetch_weather`。


## 方式二：代码级自定义工具

适用于需要深度集成到 Sema 内部的工具：

```javascript
import { z } from 'zod'

export const MyCustomTool = {
  name: 'MyTool',

  // 字符串或函数均可
  description: '执行自定义操作的工具描述，告诉 LLM 何时使用',

  inputSchema: z.object({
    param1: z.string().describe('参数1的详细说明'),
    param2: z.number().optional().describe('可选的数值参数'),
  }),

  isReadOnly() {
    return false  // 串行执行
  },

  async validateInput({ param1 }, agentContext) {
    if (!param1 || param1.length === 0) {
      return { result: false, message: 'param1 不能为空' }
    }
    return { result: true }
  },

  // 必需：将工具输出格式化为返回给 LLM 的文本
  genResultForAssistant(data) {
    return `处理结果: ${JSON.stringify(data)}`
  },

  genToolPermission({ param1 }) {
    return {
      title: `执行 MyTool: ${param1}`,
      summary: '可选的摘要说明',     // 可选字段
      content: { param1 },           // 展示给用户的详细信息
    }
  },

  genToolResultMessage(data, input) {
    return {
      title: 'MyTool 执行结果',
      summary: `成功处理: ${data.result}`,
      content: data,
    }
  },

  getDisplayTitle({ param1 }) {
    return `MyTool(${param1})`
  },

  async *call({ param1, param2 }, agentContext) {
    // 执行工具逻辑
    const result = await doSomething(param1, param2)

    // resultForAssistant 可选，若提供则优先用于回传给 LLM，否则调用 genResultForAssistant
    yield { type: 'result', data: result }
  },
}
```


## 注意事项

- `inputSchema` 使用 `z.object()`；如需严格拒绝额外字段，可使用 `z.strictObject()`
- `genResultForAssistant` 是**必需**方法，用于将输出序列化为返回给 LLM 的文本
- `call()` 是异步生成器，通过 `yield { type: 'result', data }` 返回结果；可附加可选的 `resultForAssistant` 字段覆盖 `genResultForAssistant` 的输出
- `agentContext.agentId` 用于区分主 Agent 和 SubAgent
- 若工具有副作用，`isReadOnly()` 必须返回 `false`（只有所有工具都返回 `true` 时才并发执行）
- `validateInput` 返回 `{ result: false }` 会阻止工具执行，错误信息会返回给 LLM
- `genToolPermission` 的返回值中 `summary` 为可选字段
