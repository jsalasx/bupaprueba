import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GoogleLoginTest } from './google-login-test';
import { MSAL_INSTANCE } from '../auth/auth.config';

/** MSAL real no puede correr en jsdom (toca window.location y sessionStorage). */
const msalStub = {
  initialize: () => Promise.resolve(),
  handleRedirectPromise: () => Promise.resolve(null),
  getActiveAccount: () => null,
  getAllAccounts: () => [],
  setActiveAccount: () => {},
};

describe('GoogleLoginTest', () => {
  let component: GoogleLoginTest;
  let fixture: ComponentFixture<GoogleLoginTest>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GoogleLoginTest],
      providers: [{ provide: MSAL_INSTANCE, useValue: msalStub }],
    }).compileComponents();

    fixture = TestBed.createComponent(GoogleLoginTest);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
