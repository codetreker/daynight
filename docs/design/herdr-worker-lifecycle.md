# Herdr 生命周期历史

Worker 不再运行或恢复 Herdr，也不打开其本机 lifecycle 数据库。既有资源由用户处理；已上传的历史录像继续按 [Session v2 契约](../spec/session-v2.md)只读访问。当前 Controller 机制由 [Task Session 设计](task-session-protocol.md)拥有。

## 身份与存储

原 lifecycle 的身份、存储和格式转换见[历史设计](https://github.com/codetreker/daynight/blob/34677fd0516e980c70b766db8651186fa3bc7c16/docs/design/herdr-worker-lifecycle.md#身份与存储)。

## 启动与首次输入

原启动与输入机制见[历史设计](https://github.com/codetreker/daynight/blob/34677fd0516e980c70b766db8651186fa3bc7c16/docs/design/herdr-worker-lifecycle.md#启动与首次输入)。

## Session 连接与采集段

原连接和采集机制见[历史设计](https://github.com/codetreker/daynight/blob/34677fd0516e980c70b766db8651186fa3bc7c16/docs/design/herdr-worker-lifecycle.md#session-连接与采集段)。
