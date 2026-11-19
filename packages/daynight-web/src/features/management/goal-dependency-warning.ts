export const goalDependencyWarning = (zh: boolean): string => zh
  ? "所有与此项目相关的 Goal 依赖将永久移除，包括项目内依赖、外部前置及其他项目对本项目 Goal 的依赖。这些关系无法恢复。"
  : "All Goal dependencies associated with this project will be permanently removed. This includes dependencies within the project, external prerequisites, and dependencies from other projects on Goals in this project. These relationships cannot be restored.";
