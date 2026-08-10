export type TypecheckProject = {
  name: string;
  config: string;
};

export const TYPECHECK_PROJECTS: TypecheckProject[];

export type TypecheckSpawn = (
  binary: string,
  args: string[],
  options: {
    cwd: string;
    stdio: "inherit";
  },
) => {
  status: number | null;
};

export function runTypecheckProjects(options?: {
  spawn?: TypecheckSpawn;
  binary?: string;
  output?: {
    write(chunk: string): unknown;
  };
}): number;
