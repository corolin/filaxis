/**
 * session-types.ts — 会话生命周期公共类型
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * 类型段，按 REQ-0001 OSS 化裁剪：
 * - 剔除 notifyQueue（通知路由目标队列——消息队列路由属消费方桥，内核零队列红线）
 * - ownerSessionId 保留（纯透传的归属上下文 ID，无业务语义负载）
 * - 新增终态三态 SessionFinalStatus（FEAT-04：终止即请求、死亡须核实）
 */

export interface SessionStartOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** 会话名（sessionId 前缀，便于人读） */
    name?: string;
    /** 归属上下文 ID（事件通知时原样透传，供调用方关联自己的任务/请求） */
    ownerSessionId?: string;
}

export interface SessionHandleInfo {
    sessionId: string;
    /** 落盘日志基名——实际双文件 `<logBase>.out` / `<logBase>.err`（FEAT-04 双文件协议） */
    logBase: string;
    pid?: number;
}

/**
 * 会话终态三态（FEAT-04 / REQ §3.2 细则 6）：
 * - exited   收到进程退出码（自然退出或终止后的确认退出）
 * - stopped  终止请求已发出且清理核实通过
 * - unknown  核实不可达（SSH 断线/网络分区/核实超时）——显式暴露，严禁当成功
 */
export type SessionFinalStatus = "exited" | "stopped" | "unknown";

export interface SessionFinalState {
    status: SessionFinalStatus;
    exitCode?: number;
}

export type SessionEvent =
    | {
          type: "match";
          sessionId: string;
          watcherId: string;
          pattern: string;
          matchedLine: string;
          /** 命中行所属流（FEAT-04/05 双流标记） */
          stream: "stdout" | "stderr";
          context: string[];
          /** 归属上下文（调用方透传） */
          ownerSessionId?: string;
      }
    | { type: "exit"; sessionId: string; exitCode: number | null; lastLines: string[]; ownerSessionId?: string };

export interface WatchOptions {
    pattern: string | RegExp;
    /** 命中携带 命中行 ± N 行，默认 5 */
    contextLines?: number;
    /** 命中一次即摘除（默认 true） */
    once?: boolean;
    /**
     * 命中即收摊：watcher 命中后自动 stop 会话——「观察对象结束 → 观察者退场」
     * 从模型自觉变机制。观察型会话（tail -f 等永不退出的流）尤其需要，防遗忘泄漏。
     */
    thenStop?: boolean;
}

/** 输出流标记（FEAT-04/05：双流行对象——stdout/stderr 物理分离） */
export type OutputStream = "stdout" | "stderr";

export interface ReadLogOptions {
    /** 取最近 N 行（缺省=全量） */
    lines?: number;
    /** 自文件头跳过 N 行 */
    offsetLines?: number;
    /** 读哪条流的落盘文件（FEAT-04 双文件协议；缺省 "stdout"） */
    stream?: OutputStream;
}
