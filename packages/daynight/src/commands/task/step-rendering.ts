import { stringifyApiJson } from "../../api/json.js";
import type { StepResource, StepsResource } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";

export const stepText = (value: string): string => terminalText(value).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
  (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);

const identity = (resource: StepResource | StepsResource): readonly string[] => [
  `Task: ${stepText(resource.taskId)}`,
  `Project: ${stepText(resource.projectId)}`,
  `Version: ${resource.version}`,
];

export const renderTaskSteps = (resource: StepsResource, check?: () => void): string => {
  check?.();
  const lines = [...identity(resource), `Steps: ${resource.steps.length}`];
  resource.steps.forEach((step, index) => {
    check?.();
    lines.push(`${index + 1}. ${stepText(step.id)}  ${stepText(step.status)}  ${stepText(step.title)}`);
  });
  check?.();
  return `${lines.join("\n")}\n`;
};

export const renderTaskStep = (resource: StepResource, check?: () => void): string => {
  check?.();
  const { step } = resource;
  const output = [...identity(resource),
    `Step: ${stepText(step.id)}`,
    `Status: ${stepText(step.status)}`,
    `Title: ${stepText(step.title)}`,
    `Description: ${stepText(step.description)}`,
    `Created: ${stepText(step.createdAt)}`,
    `Updated: ${stepText(step.updatedAt)}`,
    "",
  ].join("\n");
  check?.();
  return output;
};

export const renderTaskStepsJson = (resource: StepsResource | StepResource, check?: () => void): string => {
  check?.();
  const output = `${stringifyApiJson(resource)}\n`;
  check?.();
  return output;
};
