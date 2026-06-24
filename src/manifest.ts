import componentsData from "./components.json";

export interface PropDef {
  name: string;
  type: "string" | "boolean" | "enum" | "array" | "object";
  description?: string;
  values?: string[];
  default?: string;
}

export interface ComponentDef {
  name: string;
  label: string;
  description: string;
  docs?: string;
  registeredByDefault?: boolean;
  props: PropDef[];
  snippet: string;
}

const components: ComponentDef[] = (componentsData as { components: ComponentDef[] }).components;

const byName = new Map<string, ComponentDef>();
for (const component of components) {
  byName.set(component.name, component);
}

export const getComponents = (): ComponentDef[] => components;

export const getComponent = (name: string): ComponentDef | undefined =>
  byName.get(name);

export const isKnownComponent = (name: string): boolean => byName.has(name);

export const getComponentNames = (): string[] =>
  components.map((component) => component.name);
