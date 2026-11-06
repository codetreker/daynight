package bot

import (
	"encoding/hex"
	"reflect"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// CreationResolution binds an out-of-transaction capability observation to the
// exact default inputs checked again in the insertion transaction.
type CreationResolution struct {
	Expected           model.BotConfiguration
	ExpectedPreference model.BotNativePreference
	Configuration      model.BotConfiguration
}

func nativeText(value string, limit int) bool {
	return value != "" && strings.TrimSpace(value) != "" && len(value) <= limit && utf8.ValidString(value) && !strings.ContainsFunc(value, unicode.IsControl)
}
func NormalizeOverrides(overrides model.BotOverrides) error {
	if overrides.Model != nil && !nativeText(*overrides.Model, 256) {
		return invalidInput("Bot model must be nonempty Unicode without control characters and at most 256 UTF-8 bytes.")
	}
	if overrides.ReasoningEffort != nil && !nativeText(*overrides.ReasoningEffort, 64) {
		return invalidInput("Bot reasoning effort must be nonempty Unicode without control characters and at most 64 UTF-8 bytes.")
	}
	return nil
}
func validSource(source string, value *string) bool {
	switch source {
	case "explicit", "preference", "local", "cloud":
		return value != nil
	case "native":
		return true
	case "unknown":
		return value == nil
	default:
		return false
	}
}
func validateSelection(configuration model.BotConfiguration) error {
	selection := configuration.Selection
	if selection == nil {
		if configuration.ReasoningEffort != nil {
			return invalidInput("Bot reasoning effort requires a versioned selection.")
		}
		return nil
	}
	if selection.SchemaVersion != 1 || !validSource(selection.ModelSource, configuration.Model) || !validSource(selection.ReasoningEffortSource, configuration.ReasoningEffort) ||
		configuration.Model != nil && !nativeText(*configuration.Model, 256) || configuration.ReasoningEffort != nil && !nativeText(*configuration.ReasoningEffort, 64) {
		return invalidInput("Bot native selection must contain valid values and their sources.")
	}
	if selection.ConfigurationGeneration != "" {
		value, err := hex.DecodeString(selection.ConfigurationGeneration)
		if err != nil || len(value) != 32 || strings.ToLower(selection.ConfigurationGeneration) != selection.ConfigurationGeneration {
			return invalidInput("Bot configuration generation must be a SHA-256 digest.")
		}
	}
	if selection.CatalogGeneration != "" {
		id, err := model.CanonicalID(selection.CatalogGeneration)
		if err != nil || id != selection.CatalogGeneration {
			return invalidInput("Bot catalog generation must be a canonical UUID.")
		}
	}
	return nil
}

func ValidateFrozenSelection(configuration model.BotConfiguration) error {
	return validateSelection(configuration)
}

func nativeConfiguration(worker model.WorkerSnapshot, provider model.WorkerAssistantProvider, preference model.BotWorkerPreference, overrides model.BotOverrides, base model.BotConfiguration) model.BotConfiguration {
	if worker.Telemetry.AssistantHost.CreationConfigurationVersion != 1 {
		return base
	}
	base.Selection = &model.BotSelection{SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "native"}
	if base.Model != nil {
		base.Selection.ModelSource = "cloud"
	}
	// New hosts report canonical Web arguments. Keep that base intact; the Worker
	// owns the final Provider-specific override and argument normalization.
	for index, arg := range base.Args {
		if arg == "--effort" && index+1 < len(base.Args) {
			value := base.Args[index+1]
			base.ReasoningEffort = &value
			base.Selection.ReasoningEffortSource = "cloud"
		}
	}
	runtime := worker.Telemetry.RuntimeConfiguration
	if runtime != nil && runtime.Native != nil && runtime.Native.Agent == provider.Provider {
		base.Model, base.Selection.ModelSource = runtime.Native.Model.Value, runtime.Native.Model.Source
		base.ReasoningEffort, base.Selection.ReasoningEffortSource = runtime.Native.ReasoningEffort.Value, runtime.Native.ReasoningEffort.Source
	}
	native := preference.Native[string(provider.Provider)]
	if native.Model != nil {
		base.Model = native.Model
		base.Selection.ModelSource = "preference"
	}
	if overrides.Model != nil {
		base.Model = overrides.Model
		base.Selection.ModelSource = "explicit"
	}
	if base.Model != nil {
		if effort, exists := native.Efforts[*base.Model]; exists {
			base.ReasoningEffort = &effort
			base.Selection.ReasoningEffortSource = "preference"
		}
	}
	if overrides.ReasoningEffort != nil {
		base.ReasoningEffort = overrides.ReasoningEffort
		base.Selection.ReasoningEffortSource = "explicit"
	}
	return base
}

func RequiresNativeDiscovery(configuration model.BotConfiguration) bool {
	selection := configuration.Selection
	return selection != nil && (slices.Contains([]string{"explicit", "preference"}, selection.ModelSource) || slices.Contains([]string{"explicit", "preference"}, selection.ReasoningEffortSource))
}
func ApplyCreationResolution(configuration model.BotConfiguration, preference model.BotNativePreference, resolution *CreationResolution) (model.BotConfiguration, error) {
	if resolution == nil {
		if RequiresNativeDiscovery(configuration) {
			return model.BotConfiguration{}, botConflict("Native selection requires a current Worker capability observation.")
		}
		return configuration, nil
	}
	if !reflect.DeepEqual(configuration, resolution.Expected) || !reflect.DeepEqual(preference, resolution.ExpectedPreference) {
		return model.BotConfiguration{}, botConflict("Bot defaults changed during native discovery. Read current defaults before submitting the original request again.")
	}
	return resolution.Configuration, nil
}
