import type { SetupMessages } from "../setup";

export const setup: SetupMessages = {
  navigation: "使用引导",
  eyebrow: "开始使用",
  title: "连接工具，开始工作",
  subtitle: "将 CLI 与你的 Agent 接入项目，让任务和讨论保持同步。",
  currentService: "当前服务",
  stepsLabel: "使用步骤",
  successLabel: "成功标志",
  agentRequest: "Agent 请求",
  returnToProjects: "返回项目列表",
  copyLabel: ({ title }) => `复制：${title}`,
  copyStatus: {
    pending: "正在复制…",
    copied: "已复制。",
    failed: "浏览器无法复制这段文字，请选中文字后手动复制。",
  },
  steps: {
    install: {
      title: "安装 Daynight CLI",
      description: "准备 Node.js 22 及以上版本的最新补丁，在终端安装 CLI。",
      success: "终端输出版本号。",
    },
    login: {
      title: "登录账户",
      description: "在终端运行登录命令，在浏览器核对验证码和账户后批准。",
      note: "远程终端可使用 daynight login --no-browser。默认连接 https://daynight.cc，日常使用无需配置服务地址。",
      success: "终端提示登录成功。",
    },
    project: {
      title: "创建或找到仓库项目",
      description: "在已配置 origin 的 Git 仓库中运行；已有单个匹配项目时会直接返回，并保留原名称。",
      command: 'daynight project create "项目名称"\ndaynight task list',
      note: "任务命令根据当前仓库自动找到项目。若有多个匹配项目，请按 CLI 提示使用项目 ID 明确选择。",
      success: "返回项目并正常读取任务列表；新项目的空列表是正常结果。",
    },
    skill: {
      title: "安装 Agent skill",
      description: "先安装 Codex、Copilot CLI 或 Claude Code。在交互终端选择检测到的 Agent，再选择 User 或 Project 范围；Project 范围需要位于 Git worktree。",
      note: "按安装输出的 Agent 专属提示重新加载指令。Codex 可能需要重开会话；Copilot CLI 使用 /skills reload 和 /skills info using-daynight；Claude Code 新建顶层 skill 目录后使用 /reload-skills。",
      success: "Agent 可以识别 using-daynight。",
    },
    start: {
      title: "开始使用",
      description: "在 Agent 中输入下面的请求，然后到项目页面查看创建的任务。",
      example: "使用 using-daynight，为当前项目登记一个任务：补充安装说明。",
      success: "在 Web 或 daynight task list 中看到新任务。",
    },
  },
};
