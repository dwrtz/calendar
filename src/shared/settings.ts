import inputs from "../../spekkr.inputs.json";

const hex = /^#[0-9a-fA-F]{6}$/;
export const settings = {
  appName: (typeof inputs.app_name === "string" && inputs.app_name.trim()) || "Scheduler",
  brandColor: typeof inputs.brand_color === "string" && hex.test(inputs.brand_color) ? inputs.brand_color : "#111827",
  seedDemo: inputs.seed_demo === undefined ? true : Boolean(inputs.seed_demo),
};
