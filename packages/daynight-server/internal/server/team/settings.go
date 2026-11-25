package team

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func settingsResponse(settings coreteam.Settings) api.TeamSettings {
	return api.TeamSettings{Version: settings.Version, AllowNestedSubtask: settings.AllowNestedSubtask}
}

func (h *teamHandler) getSettings(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID, "team_id", r.PathValue("teamId"))
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.WriteError(w, r, logger, "team", "get_settings", err)
		return
	}
	settings, err := h.teams.GetSettings(r.Context(), p, r.PathValue("teamId"))
	if err != nil {
		httpx.WriteError(w, r, logger, "team", "get_settings", err)
		return
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, settingsResponse(settings))
}

func (h *teamHandler) updateSettings(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID, "team_id", r.PathValue("teamId"))
	if _, err := httpx.QueryValues(r); err != nil {
		writeTeamError(w, r, logger, "update_settings", err)
		return
	}
	fields, err := httpx.DecodeObject(w, r, "version", "expectedUserId", "allowNestedSubtask")
	if err != nil {
		writeTeamError(w, r, logger, "update_settings", err)
		return
	}
	version, err := httpx.VersionInput(fields)
	if err != nil {
		writeTeamError(w, r, logger, "update_settings", err)
		return
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		writeTeamError(w, r, logger, "update_settings", err)
		return
	}
	allow, err := httpx.OptionalBool(fields, "allowNestedSubtask")
	if err == nil && allow == nil {
		err = httpx.InvalidInput("allowNestedSubtask is required and must be a boolean")
	}
	if err != nil {
		writeTeamError(w, r, logger, "update_settings", err)
		return
	}
	settings, err := h.teams.UpdateSettings(r.Context(), p, r.PathValue("teamId"), coreteam.ChangeSettings{Version: version, ExpectedUserID: expected, AllowNestedSubtask: *allow})
	if err != nil {
		writeTeamError(w, r, logger, "update_settings", err)
		return
	}
	writeTeamJSON(w, r, logger, http.StatusOK, settingsResponse(settings))
}
