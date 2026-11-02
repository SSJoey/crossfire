import './style.css';
import './debug';
import { HostApp } from './hud/host';
import { JoinApp } from './hud/join';

const root = document.getElementById('app')!;
if (location.pathname.replace(/\/+$/, '') === '/host') new HostApp(root);
else new JoinApp(root);
