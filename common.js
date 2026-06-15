export const SUPPORTED_BACKENDS = ["numpy", "cpp_standalone", "cuda_standalone"];
export const SUPPORTED_MODES = ["upload", "generate"];

export const CUBA_DEFAULTS = {
  neurons: 4000,
  duration_ms: 300,
  excitatory_ratio: 0.8,
  connection_probability: 0.02,
  refractory_ms: 5.0,
  threshold_mv: -50.0,
  reset_mv: -60.0,
  resting_mv: -49.0,
  taum_ms: 20.0,
  taue_ms: 5.0,
  taui_ms: 10.0,
  excitatory_weight_mv: 1.62,
  inhibitory_weight_mv: -9.0,
  integration_method: "exact",
  monitor_population: "all",
};

export const CUBA_EQUATIONS = `dv/dt  = (ge + gi - (v - el)) / taum : volt (unless refractory)
dge/dt = -ge / taue : volt
dgi/dt = -gi / taui : volt`;

export const BENCHMARK_SCENARIOS = {
  subgroups: {
    label: "Single group with Subgroups",
    description: "One NeuronGroup split into excitatory and inhibitory Subgroups.",
  },
  split_groups: {
    label: "Separate excitatory and inhibitory groups",
    description: "Two NeuronGroups replace Subgroups to approximate eventspace partitioning.",
  },
};

export function checkBackendSupport(backend) {
  if (backend === "numpy" || backend === "cpp_standalone") {
    return { supported: true, reason: null };
  }
  return { supported: false, reason: "Brian2CUDA is not installed." };
}
