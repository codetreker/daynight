package model

import "testing"

func TestTaskStatusValidatesCanonicalWireValues(t *testing.T) {
	for _, test := range []struct {
		wire  string
		valid bool
	}{
		{wire: "todo", valid: true},
		{wire: "in_progress", valid: true},
		{wire: "done", valid: true},
		{wire: "cancelled", valid: true},
		{wire: "cancel", valid: false},
		{wire: "Cancelled", valid: false},
		{wire: "proposed", valid: false},
		{wire: "", valid: false},
		{wire: "unknown", valid: false},
		{wire: "TODO", valid: false},
		{wire: "In_Progress", valid: false},
		{wire: "Done", valid: false},
		{wire: " todo", valid: false},
		{wire: "todo ", valid: false},
		{wire: "\tdone\n", valid: false},
	} {
		t.Run(test.wire, func(t *testing.T) {
			if valid := TaskStatus(test.wire).Valid(); valid != test.valid {
				t.Fatalf("wire status %q: validity %t, want %t", test.wire, valid, test.valid)
			}
		})
	}
}

func TestTaskStatusDistinguishesTerminalDependenciesFromExecution(t *testing.T) {
	for _, test := range []struct {
		status                     TaskStatus
		terminal, requires, starts bool
	}{
		{TaskTodo, false, false, true},
		{TaskInProgress, false, true, false},
		{TaskDone, true, true, false},
		{TaskCancelled, true, false, false},
	} {
		if test.status.IsTerminal() != test.terminal || test.status.SatisfiesDependency() != test.terminal ||
			test.status.RequiresSatisfiedPrerequisites() != test.requires || test.status.IsExecutable() != test.starts {
			t.Fatalf("status %s does not distinguish task ending, prerequisite fulfillment and execution", test.status)
		}
	}
}
