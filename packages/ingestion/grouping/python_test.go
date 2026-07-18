package grouping

import (
	"reflect"
	"strings"
	"testing"
)

const pyStandard = `Traceback (most recent call last):
  File "/app/api/routes/users.py", line 42, in get_user
    user = db.query(User).filter_by(id=user_id).one()
  File "/app/services/db.py", line 17, in one
    return self.query.one()
  File "/app/venv/lib/python3.12/site-packages/sqlalchemy/orm/query.py", line 2778, in one
    return self._iter().one()
ValueError: No row was found`

func TestIsPythonTraceback(t *testing.T) {
	if !isPythonTraceback(pyStandard) {
		t.Fatal("standard traceback not detected")
	}
	if isPythonTraceback("TypeError: x is not a function\n    at foo (app.js:1:1)") {
		t.Fatal("V8 stack misdetected as Python")
	}
}

func TestPythonFrames_OrderReversedAndLibraryFiltered(t *testing.T) {
	want := []string{"services/db.py:one", "api/routes/users.py:get_user"}
	if got := pythonFrames(pyStandard); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_DeploymentPrefixInvariance(t *testing.T) {
	a := pythonFrames(pyStandard)
	b := pythonFrames(strings.ReplaceAll(pyStandard, "/app/", "/srv/"))
	c := pythonFrames(strings.ReplaceAll(pyStandard, "/app/", "/home/deploy/"))
	if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(a, c) {
		t.Fatalf("frames differ across deployment roots: %v / %v / %v", a, b, c)
	}
}

func TestPythonFrames_LineNumberInvariance(t *testing.T) {
	shifted := strings.ReplaceAll(pyStandard, "line 42", "line 57")
	if !reflect.DeepEqual(pythonFrames(pyStandard), pythonFrames(shifted)) {
		t.Fatal("line-number shift changed frame identity")
	}
}

func TestPythonFrames_ChainedExceptionsUseOutermost(t *testing.T) {
	chained := `Traceback (most recent call last):
  File "/app/inner.py", line 1, in inner_fn
    raise KeyError("k")
KeyError: 'k'

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/app/outer.py", line 9, in outer_fn
    handle()
RuntimeError: handling failed`
	want := []string{"outer.py:outer_fn"}
	if got := pythonFrames(chained); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_RecursionDeduplicated(t *testing.T) {
	var b strings.Builder
	b.WriteString("Traceback (most recent call last):\n")
	for i := 0; i < 30; i++ {
		b.WriteString("  File \"/app/recurse.py\", line 5, in spin\n    spin()\n")
	}
	b.WriteString("RecursionError: maximum recursion depth exceeded")
	want := []string{"recurse.py:spin"}
	if got := pythonFrames(b.String()); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_GunicornWrapperFiltered(t *testing.T) {
	stack := `Traceback (most recent call last):
  File "/usr/local/lib/python3.12/site-packages/gunicorn/workers/sync.py", line 136, in handle
    self.handle_request(listener, req, client, addr)
  File "/app/api/app.py", line 12, in view
    boom()
TypeError: boom`
	want := []string{"api/app.py:view"}
	if got := pythonFrames(stack); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_MalformedReturnsEmpty(t *testing.T) {
	if got := pythonFrames("Traceback (most recent call last):\ngarbage"); len(got) != 0 {
		t.Fatalf("expected no frames, got %v", got)
	}
}

func TestIsExceptionGroupTraceback(t *testing.T) {
	eg := `  + Exception Group Traceback (most recent call last):
  |   File "/app/main.py", line 3, in <module>
  |     raise ExceptionGroup("many", [ValueError("a")])`
	if !isExceptionGroupTraceback(eg) {
		t.Fatal("ExceptionGroup traceback not detected")
	}
	if isExceptionGroupTraceback(pyStandard) {
		t.Fatal("standard traceback misdetected as ExceptionGroup")
	}
}

func TestPythonFrames_CapsAtFiveNewestFirst(t *testing.T) {
	var b strings.Builder
	b.WriteString("Traceback (most recent call last):\n")
	for _, frame := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		b.WriteString("  File \"/app/" + frame + ".py\", line 1, in fn_" + frame + "\n    x()\n")
	}
	b.WriteString("ValueError: x")
	want := []string{"g.py:fn_g", "f.py:fn_f", "e.py:fn_e", "d.py:fn_d", "c.py:fn_c"}
	if got := pythonFrames(b.String()); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPythonFrames_NestedDeploymentPrefixes(t *testing.T) {
	a := pythonFrames("Traceback (most recent call last):\n  File \"/usr/src/app/x.py\", line 1, in fn\n    x()\nValueError: x")
	b := pythonFrames("Traceback (most recent call last):\n  File \"/app/x.py\", line 1, in fn\n    x()\nValueError: x")
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("nested prefix mismatch: %v vs %v", a, b)
	}
}

func TestPythonFrames_ChainMarkerInMessageIgnored(t *testing.T) {
	stack := "Traceback (most recent call last):\n  File \"/app/x.py\", line 1, in fn\n    x()\nValueError: saw 'During handling of the above exception, another exception occurred:' in logs"
	if got := pythonFrames(stack); len(got) != 1 {
		t.Fatalf("message containing marker text segmented the traceback: %v", got)
	}
}
