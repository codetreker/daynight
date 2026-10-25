package server

import (
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func (h *Authentication) registerDeviceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/device/code", h.deviceCode)
	mux.HandleFunc("POST /api/v1/auth/device/token", h.deviceToken)
	mux.HandleFunc("POST /api/v1/auth/device/inspect", h.requireDeviceBrowser(h.deviceInspect))
	mux.HandleFunc("POST /api/v1/auth/device/decision", h.requireDeviceBrowser(h.deviceDecision))
	mux.HandleFunc("POST /api/v1/auth/device/logout", h.Require(h.deviceLogout))
	for _, path := range []string{"/api/v1/auth/device/code", "/api/v1/auth/device/token"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Allow", "POST")
			h.deviceError(w, r, http.StatusMethodNotAllowed, "invalid_request")
		})
	}
	for _, path := range []string{"/api/v1/auth/device/inspect", "/api/v1/auth/device/decision", "/api/v1/auth/device/logout"} {
		mux.HandleFunc(path, h.Require(func(w http.ResponseWriter, r *http.Request, _ core.Principal) {
			methodNotAllowed(h.logger, "POST")(w, r)
		}))
	}
}

func (h *Authentication) requireDeviceBrowser(next AuthenticatedHandler) http.HandlerFunc {
	return h.Require(func(w http.ResponseWriter, r *http.Request, p core.Principal) {
		if p.Kind != core.SessionCredential {
			writeError(w, r, h.logger, "auth", "device_browser", &service.Fault{Code: "forbidden", Message: "A main-site browser session is required for this operation."})
			return
		}
		next(w, r, p)
	})
}

func (h *Authentication) deviceError(w http.ResponseWriter, r *http.Request, status int, code string) {
	writeJSON(w, r, h.logger, status, struct {
		Error string `json:"error"`
	}{Error: code})
}

func deviceForm(w http.ResponseWriter, r *http.Request, required ...string) (url.Values, error) {
	media, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/x-www-form-urlencoded" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") || r.URL.RawQuery != "" {
		return nil, invalidInput("Device authorization requires a UTF-8 form body without query parameters.")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil || !utf8.Valid(body) {
		return nil, invalidInput("Device authorization form exceeds its input limit.")
	}
	values, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, invalidInput("Device authorization form is invalid.")
	}
	for _, entries := range values {
		if len(entries) != 1 {
			return nil, invalidInput("Device authorization fields must occur once.")
		}
	}
	for _, key := range required {
		if values.Get(key) == "" {
			return nil, invalidInput("Device authorization fields are required.")
		}
	}
	return values, nil
}

func deviceSource(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (h *Authentication) writeDeviceFailure(w http.ResponseWriter, r *http.Request, err error) {
	var grant *service.DeviceGrantError
	if errors.As(err, &grant) {
		h.deviceError(w, r, 400, grant.Code)
		return
	}
	var fault *service.Fault
	if errors.As(err, &fault) && fault.Code == "rate_limited" {
		w.Header().Set("Retry-After", "60")
		h.deviceError(w, r, 429, "slow_down")
		return
	}
	LogFailure(h.logger, r.Context(), "auth", "device", err)
	h.deviceError(w, r, 500, "server_error")
}

func (h *Authentication) deviceCode(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values, err := deviceForm(w, r, "client_id")
	if err != nil {
		h.deviceError(w, r, 400, "invalid_request")
		return
	}
	start, err := h.identity.StartDevice(r.Context(), values.Get("client_id"), deviceSource(r))
	if err != nil {
		h.writeDeviceFailure(w, r, err)
		return
	}
	uri := h.origin + "/device"
	writeJSON(w, r, h.logger, 200, struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int    `json:"expires_in"`
		Interval                int    `json:"interval"`
	}{start.DeviceCode, start.UserCode, uri, uri + "?user_code=" + url.QueryEscape(start.UserCode), int(service.DeviceLifetime.Seconds()), 5})
}

func (h *Authentication) deviceToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values, err := deviceForm(w, r, "client_id", "grant_type", "device_code", "device_name")
	if err != nil {
		h.deviceError(w, r, 400, "invalid_request")
		return
	}
	result, err := h.identity.RedeemDevice(r.Context(), values.Get("client_id"), values.Get("grant_type"), values.Get("device_code"), values.Get("device_name"))
	if err != nil {
		h.writeDeviceFailure(w, r, err)
		return
	}
	writeJSON(w, r, h.logger, 200, struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}{result.Secret, "Bearer"})
}

func (h *Authentication) deviceInspect(w http.ResponseWriter, r *http.Request, p core.Principal) {
	fields, err := decodeObject(w, r, "userCode")
	if err != nil {
		writeError(w, r, h.logger, "auth", "device_inspect", err)
		return
	}
	code, err := requiredString(fields, "userCode")
	if err != nil {
		writeError(w, r, h.logger, "auth", "device_inspect", err)
		return
	}
	result, err := h.identity.InspectDevice(r.Context(), p, code)
	if err != nil {
		writeError(w, r, h.logger, "auth", "device_inspect", err)
		return
	}
	writeJSON(w, r, h.logger, 200, result)
}

func (h *Authentication) deviceDecision(w http.ResponseWriter, r *http.Request, p core.Principal) {
	fields, err := decodeObject(w, r, "userCode", "decision", "expectedUserId")
	if err != nil {
		writeError(w, r, h.logger, "auth", "device_decision", err)
		return
	}
	code, err := requiredString(fields, "userCode")
	if err != nil {
		writeError(w, r, h.logger, "auth", "device_decision", err)
		return
	}
	expectedUserID, err := requiredString(fields, "expectedUserId")
	if err != nil {
		writeError(w, r, h.logger, "auth", "device_decision", err)
		return
	}
	decision, err := requiredString(fields, "decision")
	if err == nil {
		err = h.identity.DecideDevice(r.Context(), p, code, decision, expectedUserID)
	}
	if err != nil {
		writeError(w, r, h.logger, "auth", "device_decision", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Authentication) deviceLogout(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if err := h.identity.LogoutDevice(r.Context(), p); err != nil {
		writeError(w, r, h.logger, "auth", "device_logout", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
