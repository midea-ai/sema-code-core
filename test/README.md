测试前先编译：

``` 
npm install
npm run build
``` 

测试：

``` 
# 添加模型配置 需要修改token
node test/addModel.test.js

# 简单会话 无工具
node test/simpleChat.test.js

# 完整交互
node test/miniCli.test.js
```

测试工具执行：

```
node test/tool/bash.test.js
node test/tool/glob.test.js
node test/tool/grep.test.js
```

添加mcp：

```
node test/mcp/mcpAdd.test.js
```
