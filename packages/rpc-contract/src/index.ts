import { z } from "zod";

export const JobStatus = z.enum(["pending", "running", "done", "failed"]);
export const Effort = z.enum(["fast", "balanced", "deep", "max"]);

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  createdAt: z.number(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1),
  template: z.string().default("claude-code"),
  instructions: z.string().default(""),
  createdAt: z.number(),
});

export const JobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: JobStatus,
  input: z.string(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Job = z.infer<typeof JobSchema>;

// Each method declares its input and output schema. This object IS the contract.
export const methods = {
  "workspace.init": { input: z.object({ name: z.string().min(1) }), output: WorkspaceSchema },
  "project.create": {
    input: z.object({
      workspaceId: z.string(),
      name: z.string().min(1),
      template: z.string().optional(),
      instructions: z.string().optional(),
    }),
    output: ProjectSchema,
  },
  "project.list": { input: z.object({ workspaceId: z.string() }), output: z.array(ProjectSchema) },
  "job.create": {
    input: z.object({ projectId: z.string(), input: z.string() }),
    output: JobSchema,
  },
  "job.run": {
    input: z.object({ jobId: z.string(), effort: Effort.optional() }),
    output: JobSchema,
  },
  "job.get": { input: z.object({ jobId: z.string() }), output: JobSchema },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Input<M extends MethodName> = z.infer<Methods[M]["input"]>;
export type Output<M extends MethodName> = z.infer<Methods[M]["output"]>;
