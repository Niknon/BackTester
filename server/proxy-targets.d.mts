export type ProxyTargetValue = string | { target: string; headers?: Record<string, string> };
export declare const PROXY_TARGETS: Record<string, ProxyTargetValue>;
export declare function proxyTarget(value: ProxyTargetValue): { target: string; headers: Record<string, string> };
