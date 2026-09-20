import io
import json
import os
import time
import traceback

REPORT = os.path.splitext(__file__)[0] + '.json'
SETTINGS = os.path.join(os.path.dirname(__file__), 'connect-settings.json')
PORT = 26929


def write_report(value):
    value['updatedAt'] = int(time.time() * 1000)
    with io.open(REPORT, 'w', encoding='utf-8') as report:
        report.write(json.dumps(value, ensure_ascii=True))


def progress(status):
    write_report({'ok': None, 'pending': True, 'status': status, 'port': PORT})


def connect():
    progress('loading_grasshopper')
    rs.Command('_Grasshopper', False)
    import Grasshopper
    from System.Drawing import PointF
    instances = Grasshopper.Instances
    if not Grasshopper.Kernel.GH_Document.EnableSolutions:
        return {'ok': False, 'code': 'SOLVER_DISABLED', 'message': 'Enable the Grasshopper solver before connecting.'}
    progress('finding_bridge')
    for document in instances.DocumentServer:
        for component in document.Objects:
            if component.ComponentGuid == BRIDGE_ID:
                values = list(component.Params.Input[0].VolatileData.AllData(True))
                if not values:
                    values = list(component.Params.Input[0].PersistentData.AllData(True))
                if values and str(values[0]) == str(PORT):
                    # A saved component may exist before its listener has started.
                    # Recompute only an enabled document or our own connector document.
                    if not document.Enabled and os.path.basename(document.FilePath or '') != 'Corvas-MCP.gh':
                        continue
                    progress('starting_bridge')
                    document.Enabled = True
                    component.ExpireSolution(False)
                    document.NewSolution(False)
                    return {'ok': True, 'status': 'restarted_bridge', 'port': PORT}
    component = instances.ComponentServer.EmitObject(BRIDGE_ID)
    if component is None:
        return {'ok': False, 'code': 'PLUGIN_MISSING',
                'message': 'Cordyceps is not loaded. Install a version compatible with this Rhino runtime.'}
    document = Grasshopper.Kernel.GH_Document()
    document.FilePath = os.path.join(os.path.dirname(__file__), 'Corvas-MCP.gh')
    document.Enabled = False
    component.CreateAttributes()
    component.Attributes.Pivot = PointF(120, 100)
    component.Params.Input[0].PersistentData.Clear()
    component.Params.Input[0].PersistentData.Append(Grasshopper.Kernel.Types.GH_Integer(PORT))
    document.AddObject(component, False)
    instances.DocumentServer.AddDocument(document)
    if instances.ActiveCanvas is not None:
        instances.ActiveCanvas.Document = document
    document.Enabled = True
    progress('starting_bridge')
    document.NewSolution(False)
    return {'ok': True, 'status': 'started_bridge', 'port': PORT}


try:
    progress('script_started')
    import Rhino
    import System
    import rhinoscriptsyntax as rs
    BRIDGE_ID = System.Guid('c0d1c3e5-0001-0001-0001-000000000001')
    if os.path.isfile(SETTINGS):
        with io.open(SETTINGS, 'r', encoding='utf-8') as settings_file:
            PORT = int(json.load(settings_file).get('port', PORT))
    result = connect()
except Exception:
    result = {'ok': False, 'code': 'BOOTSTRAP_FAILED', 'message': traceback.format_exc()}
result['rhinoVersion'] = str(Rhino.RhinoApp.Version) if 'Rhino' in globals() else 'unknown'
write_report(result)
print('Corvas MCP: ' + result.get('status', result.get('code', 'unknown')))
if not result.get('ok'):
    print(result.get('message', 'Connection setup failed.'))
