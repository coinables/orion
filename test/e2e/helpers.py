"""Small helpers shared by the workspace end-to-end tests."""


def idle(page, timeout=15000):
    """Wait until no action is running and the layout animation has finished."""
    page.wait_for_function("() => !window.__orion.state.busy && !window.__orion.renderer.anim", timeout=timeout)


def open_query(page, q):
    page.fill("#q", q)
    page.click("#searchForm button[type=submit]")
    page.wait_for_function("() => window.__orion.state.busy || window.__orion.state.graph.nodes.size > 0 || !document.getElementById('toast').hidden")
    idle(page)


def node_ids(page, kind=None):
    return page.evaluate(
        "(kind) => [...window.__orion.state.graph.nodes.values()].filter(n => !kind || n.type === kind).map(n => n.id)", kind)


def counts(page):
    return page.evaluate("() => { const g = window.__orion.state.graph; const v = window.__orion.renderer.data && window.__orion.renderer.data.visible;"
                         " return { nodes: g.nodes.size, edges: g.edges.size, vnodes: v ? v.nodes.size : 0, vedges: v ? v.edges.size : 0 }; }")


def xy(page, node_id):
    """Page coordinates of a vertex on the canvas (for real mouse clicks)."""
    return page.evaluate(
        "(id) => { const r = window.__orion.renderer, p = r.positionOf(id), v = r.view, b = r.canvas.getBoundingClientRect();"
        " return { x: b.left + p.x * v.k + v.x, y: b.top + p.y * v.k + v.y }; }", node_id)


def click_node(page, node_id, dbl=False):
    p = xy(page, node_id)
    if dbl:
        page.mouse.dblclick(p["x"], p["y"])
    else:
        page.mouse.click(p["x"], p["y"])


def settle(page):
    """Wait for the canvas to finish resizing and refitting after a panel opened or closed (two animation frames, then idle)."""
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))")
    idle(page)


def selected(page):
    return page.evaluate("() => [...window.__orion.state.selected]")


def canvas_has_ink(page):
    """True when the canvas shows something other than the plain background."""
    return page.evaluate("""() => {
      const c = window.__orion.renderer.canvas, ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const bg = [0x1c, 0x14, 0x1d]; let ink = 0;
      for (let i = 0; i < d.length; i += 4 * 7) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) ink++;
      return ink;
    }""")


def toast_text(page):
    return page.evaluate("() => { const t = document.getElementById('toast'); return t.hidden ? '' : t.textContent; }")


def set_slider(page, selector, value):
    page.evaluate("([s, v]) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }", [selector, value])
