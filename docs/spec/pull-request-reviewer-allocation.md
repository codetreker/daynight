# PR reviewer 分配

已连接并启用 GitHub PR 同步的 Project 可以为同步到的 Open PR 分配一个长期 reviewer。归属只针对该 Project 中的同一个 GitHub PR，保留到后续同步、换 head 和关闭后重开。

Worker 的账号拥有独立的 review 参与开关，默认关闭。服务端从已开启参与、近期成功上报、已配置该 Project 且当前具有 Project 访问权的 Worker 中选择。没有合适的 Worker 时，PR 保持未分配。服务端继续处理待分配的 PR，直到可以分配或其已不处于 Open 状态。并发分配只产生一个归属。

Reviewer 暂时离线、关闭参与开关或变更项目配置时，已有归属保留。关闭参与后停止接收新 PR。受权的 PR 列表和详情返回是否已分配以及当前的 reviewer。

本能力只决定长期归属。Worker 领取、执行容量及审批资格由审查执行流程决定。草稿 PR 可以先分配，开始审查需要满足该执行流程的条件。
