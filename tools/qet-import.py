#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 QElectroTech 官方符号库抽取 IEC 60617 / GB-T 4728 几何，生成 js/symgeo.js。

为什么要这么做：
  手画符号永远会有细节偏差（触点刀口角度、固定触点单侧短横、熔断器贯穿线…）。
  这个脚本直接读标准库的线段坐标，转成我们的渲染数据，保证形状是标准的。

用法：
  python tools/qet-import.py            # 增量下载 + 重新生成 js/symgeo.js
  python tools/qet-import.py --offline  # 只用已下载的本地文件（.cache/qet）

加一个新符号：在下面的 SPEC 里加一行，重跑即可。

数据来源：https://github.com/qelectrotech/qelectrotech-elements
许可：CC BY-SA 4.0（符号库本身）。本脚本只提取几何坐标用于绘制，
      生成的文件顶部保留来源与许可声明。
"""

import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, '.cache', 'qet')
OUT = os.path.join(ROOT, 'js', 'symgeo.js')

BASE = 'https://fastly.jsdelivr.net/gh/qelectrotech/qelectrotech-elements@main/'
IEC = '10_electric/91_en_60617/'

# key, 库内相对路径（省略 IEC 前缀与 .elmt）, 中文名, 通电时刀口额外旋转角度
SPEC = [
    # ---------- 触点 / 按钮 / 开关 ----------
    ('no',         '07/en_60617_07_02/en_60617_07_02_01', '常开触点', 19.2),
    ('nc',         '07/en_60617_07_02/en_60617_07_02_03', '常闭触点', -28),
    ('co',         '07/en_60617_07_02/en_60617_07_02_04', '转换触点', None),
    ('btnNo',      '07/en_60617_07_07/en_60617_07_07_02', '按钮（常开）', 19.2),
    ('btnPull',    '07/en_60617_07_07/en_60617_07_07_03', '拉钮（常开）', 19.2),
    ('btnTurn',    '07/en_60617_07_07/en_60617_07_07_04', '旋钮开关', None),
    ('btnStop',    '07/en_60617_07_07/en_60617_07_07_06', '急停按钮', 19.2),
    ('limit',      '07/en_60617_07_08/en_60617_07_08_01', '行程开关（常开）', 19.2),
    ('limitNc',    '07/en_60617_07_08/en_60617_07_08_02', '行程开关（常闭）', -28),
    ('tempsw',     '07/en_60617_07_09/en_60617_07_09_03', '温度开关（热元件）', -28),
    ('sw',         '07/en_60617_07_07/en_60617_07_07_01', '手动开关', None),
    ('prox',       '07/en_60617_07_19/en_60617_07_19_01', '接近开关', None),
    ('proxM',      '07/en_60617_07_20/en_60617_07_20_03', '接近开关（磁性）', None),
    ('touch',      '07/en_60617_07_19/en_60617_07_19_04', '触摸开关', None),

    # ---------- 主电路开关器件 ----------
    ('contactor1', '07/en_60617_07_13/en_60617_07_13_02', '接触器主触点', 19.2),
    ('breaker',    '07/en_60617_07_13/en_60617_07_13_05', '断路器', None),
    ('disc',       '07/en_60617_07_13/en_60617_07_13_08', '隔离开关', 19.2),

    # ---------- 线圈 ----------
    ('coil',       '07/en_60617_07_15/en_60617_07_15_01', '线圈', None),
    ('coilSlowR',  '07/en_60617_07_15/en_60617_07_15_07', '线圈（缓放）', None),
    ('coilSlowO',  '07/en_60617_07_15/en_60617_07_15_08', '线圈（缓吸）', None),
    ('coilTherm',  '07/en_60617_07_15/en_60617_07_15_21', '热继电器驱动件', None),

    # ---------- 保护 ----------
    ('fuse',       '07/en_60617_07_21/en_60617_07_21_01', '熔断器', None),
    ('fuseSw',     '07/en_60617_07_21/en_60617_07_21_07', '熔断器式开关', None),
    ('sparkgap',   '07/en_60617_07_22/en_60617_07_22_01', '火花间隙', None),
    ('gnd',        '02/en_60617_02_15/en_60617_02_15_01', '接地', None),
    ('gndProt',    '02/en_60617_02_15/en_60617_02_15_03', '保护接地', None),

    # ---------- 电机 / 变压器 ----------
    ('motor3',     '06/en_60617_06_08/en_60617_06_08_01', '三相笼型电机', None),
    ('motor3W',    '06/en_60617_06_08/en_60617_06_08_03', '三相绕线电机', None),
    ('gen',        '06/en_60617_06_04/en_60617_06_04_01', '电机通用符号', None),
    ('trans2',     '06/en_60617_06_09/en_60617_06_09_01', '双绕组变压器', None),
    ('ct',         '06/en_60617_06_09/en_60617_06_09_10', '电流互感器', None),

    # ---------- 半导体 / 信号 ----------
    ('diode',      '05/en_60617_05_03/en_60617_05_03_01', '二极管', None),
    ('led',        '05/en_60617_05_03/en_60617_05_03_02', '发光二极管', None),
    ('lamp',       '11/en_60617_11_15/en_60617_11_15_03', '信号灯', None),
    ('luminaire',  '11/en_60617_11_15/en_60617_11_15_04', '照明灯具', None),
]

TAG = re.compile(r'<(line|rect|circle|ellipse|polyline|polygon|arc|terminal)\b([^>]*)>')
ATTR = re.compile(r'(\w+)="([^"]*)"')


def attrs(s):
    return dict(ATTR.findall(s))


def num(d, k, default=0.0):
    try:
        return float(d.get(k, default))
    except (TypeError, ValueError):
        return default


def fetch(rel):
    """下载单个 elmt 到缓存，返回本地路径。"""
    dst = os.path.join(CACHE, rel.replace('/', os.sep) + '.elmt')
    if os.path.exists(dst) and os.path.getsize(dst) > 100:
        return dst
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    url = BASE + IEC + rel + '.elmt'
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'plc-atlas/1.0'})
            body = urllib.request.urlopen(req, timeout=30).read()
            with open(dst, 'wb') as f:
                f.write(body)
            return dst
        except Exception as exc:
            if attempt == 2:
                raise RuntimeError('下载失败 %s: %s' % (rel, exc))
            time.sleep(0.5)


def arc_points(x, y, w, h, start, angle, steps=18):
    """QET 的 arc（包围盒 + 起始角 + 张角）采样成折线点，避免 SVG 弧命令的坑。"""
    import math
    cx, cy = x + w / 2.0, y + h / 2.0
    rx, ry = w / 2.0, h / 2.0
    pts = []
    for i in range(steps + 1):
        a = math.radians(start + angle * i / float(steps))
        pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    return pts


def parse(path):
    src = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'<definition([^>]*)>', src)
    head = attrs(m.group(1)) if m else {}
    body = src[src.index('<description>'):src.index('</description>')]

    shapes, pins = [], []
    for tag, raw in TAG.findall(body):
        a = attrs(raw)
        if tag == 'terminal':
            pins.append([num(a, 'x'), num(a, 'y')])
        elif tag == 'line':
            shapes.append(['L', num(a, 'x1'), num(a, 'y1'), num(a, 'x2'), num(a, 'y2')])
        elif tag == 'rect':
            shapes.append(['R', num(a, 'x'), num(a, 'y'), num(a, 'width'), num(a, 'height')])
        elif tag == 'circle':
            shapes.append(['C', num(a, 'cx'), num(a, 'cy'), num(a, 'r')])
        elif tag == 'ellipse':
            shapes.append(['E', num(a, 'x') + num(a, 'width') / 2.0,
                           num(a, 'y') + num(a, 'height') / 2.0,
                           num(a, 'width') / 2.0, num(a, 'height') / 2.0])
        elif tag == 'arc':
            pts = arc_points(num(a, 'x'), num(a, 'y'), num(a, 'width'), num(a, 'height'),
                             num(a, 'start'), num(a, 'angle'))
            shapes.append(['P', [round(v, 2) for p in pts for v in p]])
        elif tag in ('polyline', 'polygon'):
            key = 'points'
            raw_pts = a.get(key, '')
            vals = [float(v) for v in re.findall(r'-?[\d.]+', raw_pts)]
            if vals:
                shapes.append(['G' if tag == 'polygon' else 'P', vals])

    # 包围盒：图形 + 端子一起算，用于等比缩放
    xs, ys = [], []
    for s in shapes:
        if s[0] == 'L':
            xs += [s[1], s[3]]
            ys += [s[2], s[4]]
        elif s[0] == 'R':
            xs += [s[1], s[1] + s[3]]
            ys += [s[2], s[2] + s[4]]
        elif s[0] in ('C', 'E'):
            rx = s[3] if s[0] == 'C' else s[3]
            ry = s[3] if s[0] == 'C' else s[4]
            xs += [s[1] - rx, s[1] + rx]
            ys += [s[2] - ry, s[2] + ry]
        else:
            v = s[1]
            xs += v[0::2]
            ys += v[1::2]
    for p in pins:
        xs.append(p[0])
        ys.append(p[1])
    if not xs:
        xs, ys = [0.0], [0.0]

    return {
        'w': num(head, 'width'),
        'h': num(head, 'height'),
        'pins': pins,
        'shapes': shapes,
        'bbox': [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
    }


def find_blades(shapes):
    """刀口识别：一端在铰点、另一端明显偏出竖直轴的那条线。
    IEC 所有开关类符号的动触点都从铰点 (0,0) 引出，这个规则对它们一致成立。"""
    out = []
    for i, s in enumerate(shapes):
        if s[0] != 'L':
            continue
        x1, y1, x2, y2 = s[1], s[2], s[3], s[4]
        for (px, py), (qx, qy) in (((x1, y1), (x2, y2)), ((x2, y2), (x1, y1))):
            if abs(px) < 0.01 and abs(py) < 0.01 and abs(qx) > 1 and abs(qy) > abs(qx):
                out.append({'i': i, 'pivot': [0.0, 0.0]})
                break
    return out


def js_num(v):
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return ('%.2f' % v).rstrip('0').rstrip('.')


def emit(entries):
    lines = [
        '/* 自动生成，请勿手改 —— 重新生成： python tools/qet-import.py',
        ' *',
        ' * 几何来源：QElectroTech 官方元件库（qelectrotech-elements）',
        ' *   标准：IEC 60617 = GB/T 4728（等同采用）',
        ' *   许可：CC BY-SA 4.0 —— 见 https://qelectrotech.org/wiki/doc/elements_license',
        ' * 本文件仅保存从 .elmt 提取的线段/矩形/圆坐标与端子位置。',
        ' */',
        'window.SYMGEO = {',
    ]
    for key, meta in entries:
        g = meta['geo']
        shapes = []
        for s in g['shapes']:
            if s[0] in ('L', 'R', 'C', 'E'):
                shapes.append('["%s",%s]' % (s[0], ','.join(js_num(x) for x in s[1:])))
            else:
                shapes.append('["%s",[%s]]' % (s[0], ','.join(js_num(x) for x in s[1])))
        pins = ','.join('[%s,%s]' % (js_num(p[0]), js_num(p[1])) for p in g['pins'])
        blade = ','.join('{"i":%d,"p":[%s,%s]}' % (b['i'], js_num(b['pivot'][0]), js_num(b['pivot'][1]))
                         for b in find_blades(g['shapes']))
        lines.append(
            '  "%s": {name:"%s", ref:"IEC 60617-%s", w:%s, h:%s, bbox:[%s], pins:[%s], blade:[%s], shapes:[%s]},'
            % (key, meta['zh'], meta['ref'],
               js_num(g['w']), js_num(g['h']),
               ','.join(js_num(v) for v in g['bbox']),
               pins, blade, ','.join(shapes))
        )
    lines.append('};')
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--offline', action='store_true', help='不联网，只用本地缓存')
    args = ap.parse_args()

    entries, failed = [], []
    for key, rel, zh, rot in SPEC:
        path = os.path.join(CACHE, rel.replace('/', os.sep) + '.elmt')
        if args.offline and not os.path.exists(path):
            failed.append((key, 'no cache'))
            continue
        try:
            if not args.offline:
                fetch(rel)
            geo = parse(path)
            ref = rel.split('/')[-1].replace('en_60617_', '').replace('_', '-')
            entries.append((key, {'geo': geo, 'zh': zh, 'ref': ref, 'rot': rot}))
        except Exception as exc:
            failed.append((key, str(exc)))

    if not entries:
        print('没有可用符号，检查网络或缓存', file=sys.stderr)
        return 1

    body = emit(entries)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)

    print('生成 %s' % os.path.relpath(OUT, ROOT))
    print('  符号 %d 个，%.1f KB' % (len(entries), len(body) / 1024.0))
    for key, meta in entries:
        g = meta['geo']
        print('  %-12s %-16s %gx%g  pins=%d blade=%d shapes=%d'
              % (key, meta['zh'], g['w'], g['h'], len(g['pins']),
                 len(find_blades(g['shapes'])), len(g['shapes'])))
    if failed:
        print('  失败 %d 个：%s' % (len(failed), ', '.join(k for k, _ in failed)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
