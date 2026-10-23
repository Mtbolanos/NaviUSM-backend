"""Reglas de negocio del grafo: normalización, validación y cambios de Gestión de Edificios (sin base de datos)."""
import copy

import pytest

from app.grafo.crud import (
    PESO_POR_PISO,
    SNAPSHOT_FORMAT,
    PayloadValidationError,
    apply_building_changes,
    floor_difference,
    normalize_buildings,
    validate_buildings,
)
from helpers import building_id, sample_payload


def _node(payload, name):
    return next(n for n in payload["nodes"] if n["name"] == name)


def _edge(payload, a, b):
    ids = {_node(payload, a)["id"], _node(payload, b)["id"]}
    return next(e for e in payload["edges"] if {e["from"], e["to"]} == ids)


# ------------------------------------------------------------------ normalización

class TestNormalizacion:
    def test_formato_antiguo_min_max_se_convierte_a_pisos(self):
        payload = {"buildings": [{"id": "b1", "name": "A", "min": -1, "max": 2}], "nodes": []}
        normalize_buildings(payload)
        b = payload["buildings"][0]
        assert [p["numero"] for p in b["pisos"]] == [-1, 0, 1, 2]
        assert b["acceso"] == 1
        assert "min" not in b and "max" not in b
        assert payload["meta"]["version"] == SNAPSHOT_FORMAT
        assert payload["conectores"] == []

    def test_acceso_por_defecto_es_el_piso_mas_bajo_si_no_hay_piso_1(self):
        payload = {"buildings": [{"id": "b1", "name": "A", "pisos": [{"numero": 3}, {"numero": 2}]}]}
        normalize_buildings(payload)
        b = payload["buildings"][0]
        assert b["acceso"] == 2
        assert [p["numero"] for p in b["pisos"]] == [2, 3]  # quedan ordenados

    def test_nombre_de_piso_vacio_queda_null(self):
        payload = {"buildings": [{"id": "b1", "name": "A", "acceso": 1, "pisos": [{"numero": 1, "nombre": "   "}]}]}
        normalize_buildings(payload)
        assert payload["buildings"][0]["pisos"][0]["nombre"] is None

    @pytest.mark.parametrize("numero", [True, "1", 1.5, None])
    def test_numero_de_piso_debe_ser_entero(self, numero):
        payload = {"buildings": [{"id": "b1", "name": "A", "pisos": [{"numero": numero}]}]}
        with pytest.raises(PayloadValidationError):
            normalize_buildings(payload)

    def test_el_exterior_no_se_modifica(self):
        payload = {"buildings": [{"id": "exterior", "name": "Exterior"}]}
        normalize_buildings(payload)
        assert payload["buildings"][0] == {"id": "exterior", "name": "Exterior"}


# ------------------------------------------------------------------ validación

class TestValidacion:
    def test_mapa_de_ejemplo_es_valido(self):
        payload = sample_payload()
        normalize_buildings(payload)
        validate_buildings(payload)  # no lanza

    def test_rechaza_pisos_repetidos(self):
        payload = sample_payload()
        payload["buildings"][1]["pisos"].append({"numero": 1, "nombre": None})
        normalize_buildings(payload)
        with pytest.raises(PayloadValidationError, match="repetidos"):
            validate_buildings(payload)

    def test_rechaza_acceso_fuera_de_los_pisos(self):
        payload = sample_payload()
        payload["buildings"][1]["acceso"] = 5
        normalize_buildings(payload)
        with pytest.raises(PayloadValidationError, match="acceso"):
            validate_buildings(payload)

    def test_rechaza_nodo_en_piso_inexistente(self):
        payload = sample_payload()
        _node(payload, "Pasillo 1")["floor"] = 7
        normalize_buildings(payload)
        with pytest.raises(PayloadValidationError, match="no existe"):
            validate_buildings(payload)

    def test_rechaza_tipo_de_conector_invalido(self):
        payload = sample_payload()
        payload["conectores"][0]["tipo"] = "tobogan"
        normalize_buildings(payload)
        with pytest.raises(PayloadValidationError, match="Tipo de conector"):
            validate_buildings(payload)

    def test_rechaza_parada_de_conector_inexistente(self):
        payload = sample_payload()
        _node(payload, "Escalera P1")["conector_id"] = "no-existe"
        normalize_buildings(payload)
        with pytest.raises(PayloadValidationError, match="conector que no existe"):
            validate_buildings(payload)

    def test_rechaza_parada_en_otro_edificio(self):
        payload = sample_payload()
        _node(payload, "Escalera P1")["building"] = "exterior"
        normalize_buildings(payload)
        with pytest.raises(PayloadValidationError, match="otro edificio"):
            validate_buildings(payload)

    def test_rechaza_nombre_de_piso_demasiado_largo(self):
        payload = sample_payload()
        payload["buildings"][1]["pisos"][0]["nombre"] = "x" * 101
        normalize_buildings(payload)
        with pytest.raises(PayloadValidationError, match="caracteres"):
            validate_buildings(payload)


# ------------------------------------------------------------------ peso por piso

class TestDiferenciaDePisos:
    ACCESO = {"b1": 2}

    def test_entrada_desde_el_exterior_al_piso_de_acceso_no_suma(self):
        a = {"building": "exterior", "floor": 1}
        b = {"building": "b1", "floor": 2}
        assert floor_difference(a, b, self.ACCESO) == 0
        assert floor_difference(b, a, self.ACCESO) == 0

    def test_entre_pisos_del_mismo_edificio(self):
        assert floor_difference({"building": "b1", "floor": -1}, {"building": "b1", "floor": 2}, self.ACCESO) == 3

    def test_exterior_a_un_piso_que_no_es_el_acceso(self):
        assert floor_difference({"building": None, "floor": 1}, {"building": "b1", "floor": 4}, self.ACCESO) == 3


# ------------------------------------------------------------------ Gestión de Edificios

def _cambio(payload, pisos, acceso=1, nombre="Edificio A"):
    return {"id": building_id(payload), "nombre": nombre, "acceso": acceso, "pisos": pisos}


class TestCambiosDeEdificios:
    def test_no_modifica_el_snapshot_original(self):
        payload = sample_payload()
        original = copy.deepcopy(payload)
        apply_building_changes(payload, [_cambio(payload, [{"numero": 1, "desde": 1}, {"numero": 2, "desde": 2}])], [])
        assert payload == original

    def test_renumerar_mueve_los_nodos_y_ajusta_el_peso(self):
        payload = sample_payload()
        peso_antes = _edge(payload, "Escalera P1", "Escalera P2")["weight"]
        # El piso 2 pasa a ser el 3: la escalera ahora sube dos pisos
        pisos = [{"numero": -1, "desde": -1}, {"numero": 1, "desde": 1}, {"numero": 3, "desde": 2, "nombre": "Mezzanine"}]
        result = apply_building_changes(payload, [_cambio(payload, pisos)], [])
        assert _node(result, "Baño piso 2")["floor"] == 3
        assert _edge(result, "Escalera P1", "Escalera P2")["weight"] == peso_antes + PESO_POR_PISO

    def test_eliminar_un_piso_elimina_sus_nodos_y_conexiones(self):
        payload = sample_payload()
        pisos = [{"numero": -1, "desde": -1}, {"numero": 1, "desde": 1}]  # se elimina el piso 2
        result = apply_building_changes(payload, [_cambio(payload, pisos)], [])
        nombres = {n["name"] for n in result["nodes"]}
        assert "Baño piso 2" not in nombres and "Escalera P2" not in nombres
        ids = {n["id"] for n in result["nodes"]}
        assert all(e["from"] in ids and e["to"] in ids for e in result["edges"])
        # El conector conserva su parada del piso 1, así que sigue existiendo
        assert len(result["conectores"]) == 1

    def test_conector_sin_paradas_se_elimina(self):
        payload = sample_payload()
        for n in payload["nodes"]:
            if n["name"] == "Escalera P1":
                n["floor"] = 2  # ambas paradas en el piso 2
        pisos = [{"numero": -1, "desde": -1}, {"numero": 1, "desde": 1}]
        result = apply_building_changes(payload, [_cambio(payload, pisos)], [])
        assert result["conectores"] == []

    def test_cambiar_el_acceso_ajusta_la_arista_de_entrada(self):
        payload = sample_payload()
        # Entrada directa del exterior al piso 2: con acceso en el piso 1 cuesta un piso extra
        payload["edges"].append({"id": "e-directa", "from": _node(payload, "Entrada A")["id"],
                                 "to": _node(payload, "Baño piso 2")["id"], "weight": 8.0 + PESO_POR_PISO})
        pisos = [{"numero": -1, "desde": -1}, {"numero": 1, "desde": 1}, {"numero": 2, "desde": 2}]
        # Al pasar el acceso al piso 2, esa entrada queda al nivel de la calle y deja de sumar el piso
        result = apply_building_changes(payload, [_cambio(payload, pisos, acceso=2)], [])
        assert _edge(result, "Entrada A", "Baño piso 2")["weight"] == 8.0

    def test_eliminar_edificio_borra_nodos_contorno_y_conectores(self):
        payload = sample_payload()
        zona_segura = {"id": "zs", "building": building_id(payload), "name": "Patio", "tags": ["zona_segura"],
                       "geojson": payload["zonas"][0]["geojson"]}
        payload["zonas"].append(zona_segura)
        result = apply_building_changes(payload, [], [building_id(payload)])
        assert [b["id"] for b in result["buildings"]] == ["exterior"]
        assert {n["name"] for n in result["nodes"]} == {"Entrada A"}
        assert result["edges"] == [] and result["conectores"] == []
        # El contorno se elimina; la zona segura se conserva, ahora en el exterior
        assert [z["id"] for z in result["zonas"]] == ["zs"]
        assert result["zonas"][0]["building"] is None

    def test_renombrar_actualiza_el_contorno(self):
        payload = sample_payload()
        pisos = [{"numero": n, "desde": n} for n in (-1, 1, 2)]
        result = apply_building_changes(payload, [_cambio(payload, pisos, nombre="Edificio Central")], [])
        assert result["buildings"][1]["name"] == "Edificio Central"
        assert result["zonas"][0]["name"] == "Edificio Central"

    def test_rechaza_edificio_inexistente(self):
        payload = sample_payload()
        with pytest.raises(PayloadValidationError, match="no existe"):
            apply_building_changes(payload, [{"id": "otro", "nombre": "X", "acceso": 1, "pisos": [{"numero": 1}]}], [])

    def test_rechaza_nombre_vacio(self):
        payload = sample_payload()
        with pytest.raises(PayloadValidationError, match="vacío"):
            apply_building_changes(payload, [_cambio(payload, [{"numero": 1, "desde": 1}], nombre="  ")], [])

    def test_rechaza_desde_que_no_corresponde_a_un_piso_actual(self):
        payload = sample_payload()
        with pytest.raises(PayloadValidationError, match="no corresponden"):
            apply_building_changes(payload, [_cambio(payload, [{"numero": 1, "desde": 9}])], [])
