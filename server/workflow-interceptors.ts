// Bundled into the workflow sandbox (workflowModules). Sentry can't run in
// here, so failures leave through a sink and are reported by the worker host.
import { ApplicationFailureCategory } from '@temporalio/common';
import { ApplicationFailure, proxySinks, type Sinks, type WorkflowInterceptorsFactory } from '@temporalio/workflow';

export interface SentrySinks extends Sinks {
  sentry: { workflowFailed(type: string, message: string, stack?: string): void };
}

const { sentry } = proxySinks<SentrySinks>();

export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [{
    async execute(input, next) {
      try {
        return await next(input);
      } catch (err) {
        // Only ApplicationFailure fails the execution; anything else fails the
        // workflow task, which retries and would report on every attempt.
        // Activity failures arrive as ActivityFailure and were reported by the activity interceptor.
        if (err instanceof ApplicationFailure && err.category !== ApplicationFailureCategory.BENIGN) {
          sentry.workflowFailed(err.type ?? 'ApplicationFailure', err.message, err.stack); // plain strings cross the sandbox
        }
        throw err;
      }
    },
  }],
});
