package assistanttask

import (
	"net/http"
	"strconv"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func readPage(r *http.Request, allowed ...string) (core.PageInput, error) {
	page, err := pageRequest(r, allowed...)
	if err != nil {
		return core.PageInput{}, err
	}
	query := r.URL.Query()
	result := core.PageInput{Limit: page.Limit, State: query.Get("state"), ItemID: query.Get("itemId"), TargetBotID: query.Get("targetBotId")}
	if page.Cursor != nil {
		result.Cursor = *page.Cursor
	}
	for _, value := range []string{result.ItemID, result.TargetBotID} {
		if value != "" {
			if _, err := strictID(value); err != nil {
				return core.PageInput{}, err
			}
		}
	}
	return result, nil
}
func (h *handler) get(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	if err := noQuery(r); err != nil {
		return nil, err
	}
	value, err := h.tasks.Get(r.Context(), a, taskID)
	return taskResponse(value), err
}
func (h *handler) list(_ http.ResponseWriter, r *http.Request, a core.Actor, _, _ string) (any, error) {
	page, err := readPage(r, "state", "targetBotId")
	if err != nil {
		return nil, err
	}
	value, err := h.tasks.List(r.Context(), a, page)
	return pageResponse(value, taskResponse), err
}
func (h *handler) claimOperation(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	if err := noQuery(r); err != nil {
		return nil, err
	}
	value, err := h.tasks.ClaimOperation(r.Context(), a, taskID, id)
	return claimResultResponse(value), err
}
func (h *handler) manual(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	if err := noQuery(r); err != nil {
		return nil, err
	}
	var version int64
	if value := r.PathValue("manualVersion"); value != "" {
		var err error
		version, err = strconv.ParseInt(value, 10, 64)
		if err != nil || version < 1 || strconv.FormatInt(version, 10) != value {
			return nil, httpx.InvalidInput("manualVersion must be a positive decimal int64")
		}
	}
	value, err := h.tasks.GetManual(r.Context(), a, taskID, version)
	return manualResponse(value), err
}
func (h *handler) item(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	if err := noQuery(r); err != nil {
		return nil, err
	}
	value, err := h.tasks.GetItem(r.Context(), a, taskID, id)
	return itemResponse(value), err
}

func (h *handler) manuals(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	page, err := readPage(r)
	if err != nil {
		return nil, err
	}

	value, err := h.tasks.ListManuals(r.Context(), a, taskID, page)
	return pageResponse(value, manualResponse), err
}

func (h *handler) appendices(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	page, err := readPage(r, "state")
	if err != nil {
		return nil, err
	}

	value, err := h.tasks.ListAppendix(r.Context(), a, taskID, page)
	return pageResponse(value, appendixResponse), err
}

func (h *handler) proposals(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	page, err := readPage(r, "state")
	if err != nil {
		return nil, err
	}

	value, err := h.tasks.ListProposals(r.Context(), a, taskID, page)
	return pageResponse(value, proposalResponse), err
}

func (h *handler) items(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	page, err := readPage(r, "state")
	if err != nil {
		return nil, err
	}

	value, err := h.tasks.ListItems(r.Context(), a, taskID, page)
	return pageResponse(value, itemResponse), err
}

func (h *handler) records(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	page, err := readPage(r, "itemId")
	if err != nil {
		return nil, err
	}

	value, err := h.tasks.ListRecords(r.Context(), a, taskID, page)
	return pageResponse(value, recordResponse), err
}

func (h *handler) events(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	page, err := readPage(r, "state", "targetBotId")
	if err != nil {
		return nil, err
	}
	if taskID == "" && page.TargetBotID == "" && a.BotID != nil {
		page.TargetBotID = *a.BotID
	}
	value, err := h.tasks.ListEvents(r.Context(), a, taskID, page)
	return pageResponse(value, eventResponse), err
}

func (h *handler) inquiries(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	page, err := readPage(r, "state", "itemId")
	if err != nil {
		return nil, err
	}

	value, err := h.tasks.ListInquiries(r.Context(), a, taskID, page)
	return pageResponse(value, inquiryResponse), err
}
