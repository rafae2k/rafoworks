import type { Env } from "../lib/types.js"

export interface WorkflowRoute {
  binding: Workflow
  name: string
}

/**
 * The one place that knows event type → which workflows run. Add a route as you add
 * a workflow. Returning [] means "no workflow for this event" — the dispatcher marks
 * the webhook 'skipped' with reason no_route (never leaves it 'queued' forever).
 */
export function getWorkflowsForEvent(env: Env, eventType: string): WorkflowRoute[] {
  if (eventType.startsWith("order.")) {
    return [{ binding: env.ORDER_WORKFLOW, name: "order-sync" }]
  }
  return []
}
