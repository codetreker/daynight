package bot

import (
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"slices"
)

func NativeModel(catalog ro.ModelResult, selected *string) *ro.ModelOption {
	if selected == nil {
		return nil
	}
	for _, option := range catalog.Models {
		if option.ID == *selected || slices.Contains(option.Aliases, *selected) {
			return &option
		}
	}
	return nil
}
func supportsEffort(option *ro.ModelOption, effort *string) bool {
	return effort == nil || option != nil && slices.Contains(option.ReasoningEfforts, *effort)
}

func selectionFailure(code, message string) error { return &model.Fault{Code: code, Message: message} }

// ResolveNativeSelection applies per-model preferences only after native discovery
// has established that model and the compatibility of the Worker's current values.
func ResolveNativeSelection(base model.BotConfiguration, overrides model.BotOverrides, preference model.BotNativePreference, catalog ro.ModelResult, selected *string) (model.BotConfiguration, error) {
	result := base
	selection := *base.Selection
	result.Selection = &selection
	if selected == nil {
		result.Model = catalog.Defaults.Model.Value
		selection.ModelSource = catalog.Defaults.Model.Source
	} else {
		result.Model = selected
	}
	option := NativeModel(catalog, result.Model)
	if option == nil {
		code := "unsupported_selection"
		if result.Model == nil {
			code = "unknown_default"
		}
		return base, selectionFailure(code, "Worker could not confirm the selected model from its native catalog.")
	}
	// Discovery can report an incompatible current Worker effort. Only a new
	// explicit per-assistant effort can replace that configuration error.
	if catalog.SelectionError != nil && overrides.ReasoningEffort == nil {
		return base, selectionFailure(catalog.SelectionError.Code, catalog.SelectionError.Message)
	}
	result.ReasoningEffort = catalog.Defaults.ReasoningEffort.Value
	selection.ReasoningEffortSource = catalog.Defaults.ReasoningEffort.Source
	if result.Model != nil {
		if effort, exists := preference.Efforts[*result.Model]; exists && supportsEffort(option, &effort) {
			result.ReasoningEffort = &effort
			selection.ReasoningEffortSource = "preference"
		}
	}
	if overrides.ReasoningEffort != nil {
		result.ReasoningEffort = overrides.ReasoningEffort
		selection.ReasoningEffortSource = "explicit"
	}
	if !supportsEffort(option, result.ReasoningEffort) {
		return base, selectionFailure("unsupported_selection", fmt.Sprintf("Reasoning effort is not supported by model %s.", option.ID))
	}
	selection.ConfigurationGeneration, selection.CatalogGeneration = catalog.ConfigurationGeneration, catalog.CatalogGeneration
	return result, nil
}

// NativeDelegationFallback discards unusable history only when the current
// Worker configuration itself delegates both fields to the native Provider.
func NativeDelegationFallback(baseline model.BotConfiguration, overrides model.BotOverrides, catalog ro.ModelResult, selected *string) bool {
	return selected == nil && overrides.Model == nil && overrides.ReasoningEffort == nil && baseline.Model == nil && baseline.ReasoningEffort == nil && baseline.Selection != nil && baseline.Selection.ModelSource == "native" && baseline.Selection.ReasoningEffortSource == "native" && catalog.Defaults.Model.Value == nil && catalog.Defaults.ReasoningEffort.Value == nil && catalog.Defaults.ReasoningEffort.Source != "local" && catalog.Defaults.ReasoningEffort.Source != "cloud" && catalog.Defaults.ReasoningEffort.Source != "explicit" && (catalog.SelectionError == nil || catalog.SelectionError.Code == "unknown_default")
}
