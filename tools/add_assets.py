# -*- coding: utf-8 -*-
"""
tools/add_assets.py — Amplía el catálogo con inversiones sólidas, especulativas
y chiringuitos. Se ejecuta una vez; queda en el repo como documentación de qué
se añadió y con qué criterio.

Criterio de diseño:
  - solid:       rentabilidad modesta, sin riesgo de ruina. Aburrido y fiable.
  - speculative: rentabilidad alta, con opción real de despegue (boom) Y de
                 quedarse a cero (ruin). Es una apuesta, y se nota.
  - scam:        rentabilidad imposible. Ruina casi segura y pierdes el capital.
                 Los avisos están ahí para quien mire: por eso existe la
                 due diligence.
"""
import io
import json

PATH = 'src/data/assets_database.json'

NEW = [
    # ---------------------- SÓLIDAS (aburridas y fiables) ----------------------
    dict(id='re_garaje_30', category='real_estate', sprite='assets/sprites/re_sand_block.png',
         title='Garaje junto al Hospital', quality='solid',
         description='Rotación garantizada por turnos de personal sanitario. Cero mantenimiento.',
         price=26000, down=6500, mortgage=19500, cuota=95, gross=395, maint=28, risk=0.05,
         lev=True),
    dict(id='fin_monetario_31', category='financial', sprite='assets/sprites/fin_bronze_wide.png',
         title='Fondo Monetario', quality='solid',
         description='Liquidez casi inmediata y rentabilidad pequeña. El aparcamiento del dinero.',
         price=8000, gross=52, maint=3, risk=0.02),
    dict(id='fin_infl_32', category='financial', sprite='assets/sprites/fin_gold_tall.png',
         title='Bonos Ligados a la Inflación', quality='solid',
         description='Pagan poco, pero su renta sube cuando suben los precios. Es un seguro, no un negocio.',
         price=18000, gross=128, maint=6, risk=0.03),
    dict(id='re_solar_33', category='real_estate', sprite='assets/sprites/re_olive_house.png',
         title='Instalación Fotovoltaica', quality='solid',
         description='Placas en nave industrial con contrato de venta de energía a 20 años.',
         price=48000, down=12000, mortgage=36000, cuota=165, gross=690, maint=60, risk=0.07,
         lev=True),
    dict(id='biz_lavan_34', category='digital_business', sprite='assets/sprites/biz_slate_shop.png',
         title='Lavandería de Barrio', quality='solid',
         description='Autoservicio 24h. Ingresos pequeños, constantes y sin personal.',
         price=34000, gross=760, maint=190, risk=0.12),

    # ------------------- ESPECULATIVAS (pueden salir muy bien… o a cero) -------
    dict(id='spec_startup_40', category='digital_business', sprite='assets/sprites/b_startup.png',
         title='Participación en una Startup', quality='speculative',
         description='Un 4% de la empresa de un conocido. Si escala, se multiplica; si no, cero.',
         price=25000, gross=690, maint=60, risk=0.45, ruin=0.030, boom=0.030,
         warning='Empresa sin histórico: la mayoría de startups no llegan al tercer año.'),
    dict(id='spec_defi_41', category='financial', sprite='assets/sprites/fin_purple_office.png',
         title='Staking en Protocolo DeFi', quality='speculative',
         description='Rendimiento alto en un protocolo joven. El contrato lo auditó… alguien.',
         price=12000, gross=530, maint=15, risk=0.55, ruin=0.035, boom=0.020,
         warning='Riesgo de contrato inteligente: un fallo o un hackeo se lo lleva todo.'),
    dict(id='spec_resto_42', category='digital_business', sprite='assets/sprites/b_cafe.png',
         title='Restaurante de Moda', quality='speculative',
         description='Local con cola en la puerta… hoy. La hostelería premia y castiga rápido.',
         price=70000, gross=2450, maint=1100, risk=0.35, ruin=0.022, boom=0.022,
         warning='Márgenes finos: una mala racha de tres meses se lleva el negocio por delante.'),
    dict(id='spec_turis_43', category='real_estate', sprite='assets/sprites/b_vacation.png',
         title='Piso Turístico sin Licencia', quality='speculative',
         description='Rentabilidad muy por encima del alquiler normal. Papeles "en trámite".',
         price=95000, down=28500, mortgage=66500, cuota=290, gross=2100, maint=210, risk=0.40,
         ruin=0.030, boom=0.010, lev=True,
         warning='Riesgo regulatorio: si el ayuntamiento aprieta, la licencia no llega y adiós renta.'),
    dict(id='spec_nft_44', category='financial', sprite='assets/sprites/fin_emerald_house.png',
         title='Cartera de Arte Digital', quality='speculative',
         description='Piezas de artistas emergentes que se alquilan para exposiciones virtuales.',
         price=16000, gross=640, maint=40, risk=0.58, ruin=0.040, boom=0.025,
         warning='Mercado ilíquido: el precio depende de que siga habiendo compradores.'),
    dict(id='spec_franq_45', category='digital_business', sprite='assets/sprites/b_shop.png',
         title='Franquicia de Bubble Tea', quality='speculative',
         description='La marca del momento. Canon de entrada alto y contrato de 5 años.',
         price=55000, gross=1850, maint=760, risk=0.32, ruin=0.020, boom=0.018,
         warning='Negocio de moda: cuando pasa la novedad, el canon sigue.'),

    # ---------------------------- CHIRINGUITOS ---------------------------------
    dict(id='scam_ponzi_50', category='financial', sprite='assets/sprites/b_bank.png',
         title='Fondo "Garantizado" 9% Mensual', quality='scam',
         description='Rentabilidad fija garantizada por contrato. Comercial muy insistente y sin folleto CNMV.',
         price=20000, gross=1800, maint=0, risk=0.6, ruin=0.30,
         warning='ESQUEMA PIRAMIDAL: paga a los antiguos con el dinero de los nuevos. Cuando pare, no queda nada.'),
    dict(id='scam_trading_51', category='digital_business', sprite='assets/sprites/b_coworking.png',
         title='Cuenta Gestionada de Trading', quality='scam',
         description='Un gurú opera por ti con "rentabilidad asegurada" del 7% mensual. Retirada mínima a 12 meses.',
         price=15000, gross=1050, maint=0, risk=0.6, ruin=0.32,
         warning='CHIRINGUITO FINANCIERO: sin licencia para gestionar dinero ajeno. El bloqueo de retirada es la señal.'),
    dict(id='scam_preventa_52', category='real_estate', sprite='assets/sprites/re_brick_tall.png',
         title='Preventa sobre Plano en el Extranjero', quality='scam',
         description='Apartamentos a mitad de precio en un resort por construir. Pago íntegro por adelantado.',
         price=45000, gross=2700, maint=0, risk=0.6, ruin=0.28,
         warning='PROMOTORA FANTASMA: sin aval bancario ni licencia de obra. Si no se construye, no hay a quién reclamar.'),
    dict(id='scam_mineria_53', category='financial', sprite='assets/sprites/fin_gold_tall.png',
         title='Minería Cripto Gestionada', quality='scam',
         description='Alquilas potencia de cálculo en una granja que nadie ha visitado. Pagos "diarios".',
         price=10000, gross=760, maint=0, risk=0.6, ruin=0.30,
         warning='SIN ACTIVO REAL DETRÁS: no hay forma de auditar que esas máquinas existan.'),
]


def build(d):
    f = {
        'total_price': d['price'],
        'down_payment_required': d.get('down', d['price']),
        'mortgage_available': d.get('mortgage', 0),
        'monthly_mortgage_cost': d.get('cuota', 0),
        'gross_monthly_income': d['gross'],
        'maintenance_and_taxes': d['maint'],
    }
    f['net_monthly_cashflow'] = f['gross_monthly_income'] - f['maintenance_and_taxes'] - f['monthly_mortgage_cost']
    invested = f['down_payment_required']
    coc = round(f['net_monthly_cashflow'] * 12 / invested * 100, 2) if invested else 0
    asset = {
        'id': d['id'],
        'category': d['category'],
        'sprite': d['sprite'],
        'title': d['title'],
        'description': d['description'],
        'quality': d['quality'],
        'financials': f,
        'metrics': {'coc_return_percentage': coc, 'vacancy_rate_risk': d['risk']},
        'leverage_allowed': bool(d.get('lev', False)),
    }
    outcome = {}
    if d.get('ruin'):
        outcome['ruin'] = d['ruin']
    if d.get('boom'):
        outcome['boom'] = d['boom']
    if outcome:
        asset['outcome'] = outcome
    if d.get('warning'):
        asset['warning'] = d['warning']
    return asset


def main():
    data = json.load(io.open(PATH, encoding='utf-8'))
    have = {a['id'] for a in data['assets']}
    for a in data['assets']:
        a.setdefault('quality', 'solid')
    added = 0
    for d in NEW:
        if d['id'] in have:
            continue
        data['assets'].append(build(d))
        added += 1
    io.open(PATH, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print('añadidos:', added, '· total:', len(data['assets']))


if __name__ == '__main__':
    main()
