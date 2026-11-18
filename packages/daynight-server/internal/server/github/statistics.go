package github

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *handler) statistics(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "statistics", func(id string) (any, error) {
		if len(r.URL.RawQuery) > 4096 {
			return nil, &httpx.URITooLongError{}
		}
		v, err := query(r, "endDate", "window", "authorId")
		if err != nil {
			return nil, err
		}
		end, endOK := v["endDate"]
		window, windowOK := v["window"]
		if !endOK || !windowOK {
			return nil, httpx.InvalidInput("endDate and window are required")
		}
		segments, err := parseStatisticsWindow(end[0], window[0])
		if err != nil {
			return nil, err
		}
		input := coregithub.StatisticsRequest{EndDate: end[0], Window: segments}
		if value, ok := v["authorId"]; ok {
			n, e := strconv.ParseInt(value[0], 10, 64)
			if e != nil || n <= 0 || strconv.FormatInt(n, 10) != value[0] {
				return nil, httpx.InvalidInput("authorId must be a positive decimal integer")
			}
			input.AuthorID = &n
		}
		result, err := h.reader.Statistics(r.Context(), p, id, input)
		if err != nil {
			return nil, err
		}
		return statisticsResponse(end[0], result), nil
	})
}

func parseStatisticsWindow(endDate, window string) ([]coregithub.StatisticsSegment, error) {
	invalid := func() ([]coregithub.StatisticsSegment, error) {
		return nil, httpx.InvalidInput("endDate or window is invalid")
	}
	end, err := time.Parse("2006-01-02", endDate)
	if err != nil || len(endDate) != 10 || end.Format("2006-01-02") != endDate || end.Year() < 1 {
		return invalid()
	}
	first := end.AddDate(0, 0, -29)
	if first.Year() < 1 {
		return invalid()
	}
	parts := strings.Split(window, ",")
	if len(parts) < 2 || len(parts) > 64 {
		return invalid()
	}
	segments := make([]coregithub.StatisticsSegment, len(parts))
	hasDay := false
	for i, part := range parts {
		fields := strings.Split(part, "@")
		if len(fields) != 2 {
			return invalid()
		}
		index := -1
		if fields[0] != "-" {
			index, err = strconv.Atoi(fields[0])
			if err != nil || index < 0 || index > 29 || strconv.Itoa(index) != fields[0] {
				return invalid()
			}
			hasDay = true
		}
		millis, e := strconv.ParseInt(fields[1], 10, 64)
		if e != nil || strconv.FormatInt(millis, 10) != fields[1] || millis < first.Add(-24*time.Hour).UnixMilli() || millis > end.Add(48*time.Hour).UnixMilli() {
			return invalid()
		}
		if i > 0 && (millis <= segments[i-1].StartMillis || index == segments[i-1].DateIndex) {
			return invalid()
		}
		segments[i] = coregithub.StatisticsSegment{DateIndex: index, StartMillis: millis}
	}
	if !hasDay || segments[len(segments)-1].DateIndex != -1 {
		return invalid()
	}
	for i, segment := range segments[:len(segments)-1] {
		if segment.DateIndex < 0 {
			continue
		}
		day := first.AddDate(0, 0, segment.DateIndex)
		if segment.StartMillis < day.Add(-24*time.Hour).UnixMilli() || segments[i+1].StartMillis > day.Add(48*time.Hour).UnixMilli() {
			return invalid()
		}
	}
	return segments, nil
}

func statisticsResponse(endDate string, result coregithub.Statistics) api.PullRequestStatistics {
	out := api.PullRequestStatistics{
		ProjectID: result.Connection.ProjectID, EndDate: endDate,
		Revision: decimal(result.Connection.Revision), ProjectTotal: decimal(result.ProjectTotal),
		Availability: result.Availability, HasAuthors: result.HasAuthors, AuthorID: optionalDecimal(result.AuthorID),
	}
	for i, count := range result.Daily {
		out.Daily[i] = decimal(count)
	}
	if result.Author != nil {
		out.Author = &api.PullRequestAuthor{ID: decimal(result.Author.ID), Login: result.Author.Login}
	}
	if result.AuthorDaily != nil {
		out.AuthorDaily = &[30]string{}
		for i, count := range result.AuthorDaily {
			out.AuthorDaily[i] = decimal(count)
		}
	}
	return out
}
