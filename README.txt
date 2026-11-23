mb - terminal browser for reconnaissance

USAGE
-----
    mb                  open the browser
    mb <url>            open a page directly
    :help               list commands
    :f                  list fillable fields on the page
    :f 1                focus field 1, then type; Enter submits, Esc releases
    :q                  quit

Program files live in /lib/mb. The launcher is /bin/mb.
Page JavaScript runs sandboxed and cannot reach Node, the filesystem or
arbitrary hosts. Intended for testing sites you are authorised to test.
